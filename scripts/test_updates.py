"""Updater regression checks; all installation paths/processes are test fixtures."""
import importlib.util
import io
from contextlib import closing
from pathlib import Path
import plistlib
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch


def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name.replace('_','-')+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


mac=load('update_mac');ios=load('update_ios')
OLD='a'*40;NEW='b'*40


class MacUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp=self.enterContext(tempfile.TemporaryDirectory());self.root=Path(self.temp)
        self.source=self.root/'source';self.source.mkdir();(self.source/'dist').mkdir();(self.source/'dist/index.html').write_text('old web')
        self.app=self.root/'Local Reader.app';self.app.mkdir();(self.app/'version').write_text('old app')
        self.data=self.root/'data';self.data.mkdir();self.python=self.root/'python';self.python.touch()
        self.enterContext(patch.object(mac,'APP',self.app));self.enterContext(patch.object(mac,'DATA',self.data));self.enterContext(patch.object(mac,'PYTHON',self.python))
        with closing(sqlite3.connect(self.data/'library.sqlite3')) as db, db:
            db.execute('CREATE TABLE reading(position INTEGER)');db.execute('INSERT INTO reading VALUES(42)')
        self.head=OLD;self.user_edits=False;self.calls=[];self.stage=None
        self.enterContext(patch.object(mac,'inspect',return_value={'canInstall':True,'currentCommit':OLD,'latestCommit':NEW,'installedCommit':OLD}))
        self.enterContext(patch.object(mac,'ancestor',return_value=True));self.enterContext(patch.object(mac,'clean',side_effect=lambda _:not self.user_edits))
        self.enterContext(patch.object(mac,'git',side_effect=self.git));self.run=self.enterContext(patch.object(mac,'run',side_effect=self.run_command))
        self.enterContext(patch.object(mac.shutil,'which',return_value='/test/tool'))
        self.enterContext(patch.object(mac,'wait_parent'));self.enterContext(patch.object(mac,'check_app_closed'));self.enterContext(patch.object(mac,'listener',return_value=None))
        self.stop=self.enterContext(patch.object(mac,'stop_server'));self.start=self.enterContext(patch.object(mac,'start_server',side_effect=self.start_server))
        self.health=self.enterContext(patch.object(mac,'healthy',return_value=True))
    def git(self,source,*args):
        self.calls.append(args)
        if args[:2]==('worktree','add'):
            self.stage=Path(args[3]);self.stage.mkdir();(self.stage/'dist').mkdir();(self.stage/'dist/index.html').write_text('new web');return ''
        if args[:2]==('rev-parse','HEAD'):return self.head
        if args[0]=='merge':self.head=NEW
        if args[:2]==('reset','--keep'):self.head=OLD
        return ''
    def run_command(self,args,*unused,**kwargs):
        if str(args[0]).endswith('desktop/build.sh'):
            built=self.stage/'desktop/build/Local Reader.app';(built/'Contents/MacOS').mkdir(parents=True)
            (built/'Contents/MacOS/LocalReader').touch();(built/'version').write_text('new app')
            with (built/'Contents/Info.plist').open('wb') as f:plistlib.dump({'LocalReaderSourcePath':str(self.source),'LocalReaderRevision':NEW},f)
        return ''
    def start_server(self,_):
        if self.head==NEW:
            with closing(sqlite3.connect(self.data/'library.sqlite3')) as db, db:db.execute('UPDATE reading SET position=99')
        process=Mock();process.poll.return_value=None;return process
    def test_success_preserves_data_and_backups(self):
        result=mac.install(self.source,NEW,None)
        self.assertTrue(result['success']);self.assertEqual(self.head,NEW)
        self.assertEqual((self.app/'version').read_text(),'new app')
        backup=next((self.data/'updates').glob('*/library.sqlite3'))
        with closing(sqlite3.connect(backup)) as db, db:self.assertEqual(db.execute('SELECT position FROM reading').fetchone()[0],42)
    def test_build_failure_does_not_touch_install(self):
        self.run.side_effect=mac.UpdateError('Build failed')
        with self.assertRaisesRegex(mac.UpdateError,'Build failed'):mac.install(self.source,NEW,None)
        self.stop.assert_not_called();self.assertEqual(self.head,OLD);self.assertEqual((self.app/'version').read_text(),'old app')
    def test_bad_health_rolls_back_app_source_dist_and_sqlite(self):
        self.health.side_effect=[False,True]
        with self.assertRaisesRegex(mac.UpdateError,'health check'):mac.install(self.source,NEW,None)
        self.assertEqual(self.head,OLD);self.assertEqual((self.app/'version').read_text(),'old app');self.assertEqual((self.source/'dist/index.html').read_text(),'old web')
        with closing(sqlite3.connect(self.data/'library.sqlite3')) as db, db:self.assertEqual(db.execute('SELECT position FROM reading').fetchone()[0],42)
        self.assertIn(('reset','--keep',OLD),self.calls)
    def test_new_user_edits_block_source_reset(self):
        def health(*_):self.user_edits=True;return False
        self.health.side_effect=health
        with self.assertRaisesRegex(mac.UpdateError,'preserve your edits'):mac.install(self.source,NEW,None)
        self.assertNotIn(('reset','--keep',OLD),self.calls);self.assertEqual(self.head,NEW)
    def test_dry_run_never_builds_or_stops(self):
        result=mac.install(self.source,NEW,None,True)
        self.assertTrue(result['dryRun']);self.run.assert_not_called();self.stop.assert_not_called();self.assertFalse((self.data/'updates').exists())
    def test_directory_swap_failure_restores_original(self):
        new=self.root/'new';new.mkdir();(new/'version').write_text('new')
        real=mac.os.replace
        def fail(source,dest):
            if '.update-' in str(source) and Path(dest)==self.app:raise OSError('test failure')
            return real(source,dest)
        with patch.object(mac.os,'replace',side_effect=fail),self.assertRaises(OSError):mac.replace_directory(new,self.app)
        self.assertEqual((self.app/'version').read_text(),'old app')
    def test_source_current_but_bundle_old_still_needs_update(self):
        (self.app/'Contents').mkdir()
        with (self.app/'Contents/Info.plist').open('wb') as f:plistlib.dump({'LocalReaderRevision':OLD,'CFBundleShortVersionString':'1.0','CFBundleVersion':'2'},f)
        def git(source,*args):
            if args==('rev-parse','--show-toplevel'):return str(self.source)
            if args==('branch','--show-current'):return 'main'
            if args==('remote','get-url','origin'):return 'git@github.com:ethanniser/local-reader.git'
            if args[0]=='show':return "'CFBundleShortVersionString': '1.0', 'CFBundleVersion': '3'"
            return NEW
        with patch.object(mac,'inspect',new=ORIGINAL_INSPECT),patch.object(mac,'git',side_effect=git):
            result=mac.inspect(self.source,fetch=False)
        self.assertTrue(result['updateAvailable']);self.assertTrue(result['canInstall']);self.assertEqual(result['installedCommit'],OLD)
        self.assertEqual(result['latestVersion'],'1.0 (3)')

    def test_stop_failure_recovers_previous_server_without_source_changes(self):
        self.stop.side_effect=mac.UpdateError('Server shutdown failed')
        with self.assertRaisesRegex(mac.UpdateError,'shutdown failed'):mac.install(self.source,NEW,None)
        self.assertEqual(self.head,OLD);self.start.assert_called_once_with(self.source)
    def test_wrong_staged_revision_never_stops_server(self):
        original=self.run_command
        def build(args,*rest,**kwargs):
            result=original(args,*rest,**kwargs)
            if str(args[0]).endswith('desktop/build.sh'):
                info=self.stage/'desktop/build/Local Reader.app/Contents/Info.plist'
                with info.open('wb') as f:plistlib.dump({'LocalReaderSourcePath':str(self.source),'LocalReaderRevision':OLD},f)
            return result
        self.run.side_effect=build
        with self.assertRaisesRegex(mac.UpdateError,'validation failed'):mac.install(self.source,NEW,None)
        self.stop.assert_not_called()
    def test_origin_allowlist_blocks_fetch(self):
        calls=[]
        def git(source,*args):
            calls.append(args)
            return str(self.source) if args==('rev-parse','--show-toplevel') else 'https://github.com/other/repository.git'
        with patch.object(mac,'inspect',new=ORIGINAL_INSPECT),patch.object(mac,'git',side_effect=git),self.assertRaisesRegex(mac.UpdateError,'expected'):
            mac.inspect(self.source)
        self.assertFalse(any(args[0]=='fetch' for args in calls))
    def test_health_rejects_a_different_listener(self):
        process=Mock(pid=123);process.poll.return_value=None
        with patch.object(mac,'healthy',new=ORIGINAL_HEALTH),patch.object(mac,'listener',return_value=456),patch.object(mac,'urlopen',return_value=io.BytesIO(b'{"local":true}')),patch.object(mac.time,'monotonic',side_effect=[0,0,1]),patch.object(mac.time,'sleep'):
            self.assertFalse(mac.healthy(process,self.source,seconds=.5))
    def test_cwd_prefix_is_not_server_ownership(self):
        command=' '.join([str(self.python),'-m','uvicorn','server.app:app','--host','127.0.0.1','--port','8787'])
        with patch.object(mac,'listener',new=ORIGINAL_LISTENER),patch.object(mac.subprocess,'run',return_value=Mock(stdout='123\n')),patch.object(mac,'run',side_effect=[command,'n'+str(self.source)+'-other']):
            with self.assertRaisesRegex(mac.UpdateError,'unrecognized'):mac.listener(self.source)

    def test_unrecognized_listener_is_never_stopped(self):
        # Exercise real identity check while replacing only its process probes.
        with patch.object(mac,'listener',new=ORIGINAL_LISTENER),patch.object(mac.subprocess,'run',return_value=Mock(stdout='123\n')), \
             patch.object(mac,'run',side_effect=['unrelated server','n/elsewhere']):
            with self.assertRaisesRegex(mac.UpdateError,'unrecognized'):mac.listener(self.source)


ORIGINAL_LISTENER=mac.listener
ORIGINAL_INSPECT=mac.inspect
ORIGINAL_HEALTH=mac.healthy


class IOSUpdateTests(unittest.TestCase):
    def test_explicit_team_device_and_no_uninstall(self):
        plan=ios.commands(Path('/source'),'DEVICE-1234','TEAM123456',Path('/build'))
        self.assertEqual(plan[0],['/source/ios/prepare.sh'])
        self.assertIn('DEVELOPMENT_TEAM=TEAM123456',plan[1]);self.assertIn('id=DEVICE-1234',plan[1])
        self.assertNotIn('-allowProvisioningUpdates',plan[1]);self.assertNotIn('-allowProvisioningDeviceRegistration',plan[1]);self.assertNotIn('uninstall',str(plan))
        self.assertEqual(plan[-1][2:5],['device','install','app'])
    def test_dirty_or_wrong_ios_revision_refuses_install(self):
        for head,status in [(OLD,' M file'),(NEW,'')]:
            with patch.object(ios.subprocess,'run',side_effect=[Mock(returncode=0,stdout=head),Mock(returncode=0,stdout=status)]),self.assertRaisesRegex(RuntimeError,'exact reviewed'):
                ios.verify_source(Path('/source'),OLD)
    def test_provisioning_is_explicit_opt_in(self):
        plan=ios.commands(Path('/source'),'DEVICE-1234','TEAM123456',Path('/build'),True)
        self.assertIn('-allowProvisioningUpdates',plan[1]);self.assertIn('-allowProvisioningDeviceRegistration',plan[1])



class UpdateRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp=self.enterContext(tempfile.TemporaryDirectory());self.app=Path(self.temp)/'Local Reader.app'
        self.enterContext(patch.object(mac,'APP',self.app));self.enterContext(patch.dict(mac.os.environ,{},clear=False))
        mac.os.environ.pop('LOCAL_READER_UPDATE_REPOSITORY',None)
    def record(self,value):
        (self.app/'Contents').mkdir(parents=True)
        with (self.app/'Contents/Info.plist').open('wb') as f:plistlib.dump({'LocalReaderUpdateRepository':value},f)
    def test_github_remote_forms(self):
        for url in ['git@github.com:Owner/local-reader.git','https://github.com/owner/local-reader','ssh://git@github.com/owner/local-reader.git','https://github.com/owner/local-reader.git/']:
            self.assertEqual(mac.github_repository(url),'owner/local-reader')
        for url in ['https://github.com.evil.com/owner/local-reader','https://gitlab.com/owner/local-reader','https://github.com/owner/local-reader/extra','file:///tmp/x']:
            self.assertIsNone(mac.github_repository(url))
    def test_defaults_to_upstream(self):
        self.assertEqual(mac.expected_repository(),mac.UPSTREAM_REPOSITORY)
    def test_uses_repository_recorded_at_build(self):
        self.record('someone/local-reader-fork');self.assertEqual(mac.expected_repository(),'someone/local-reader-fork')
    def test_ignores_malformed_recorded_repository(self):
        self.record('../../etc');self.assertEqual(mac.expected_repository(),mac.UPSTREAM_REPOSITORY)
    def test_environment_override(self):
        with patch.dict(mac.os.environ,{'LOCAL_READER_UPDATE_REPOSITORY':'me/reader'}):self.assertEqual(mac.expected_repository(),'me/reader')



class PythonResolutionTests(unittest.TestCase):
    def test_custom_python_is_kept_for_the_rebuilt_app(self):
        custom=Path('/opt/reader-env/bin/python')
        with patch.object(mac,'PYTHON',custom):self.assertEqual(mac.build_env(),{'LOCAL_READER_PYTHON':str(custom)})
        with patch.object(mac,'PYTHON',Path.home()/'Library/Caches/local-reader/venv/bin/python'):self.assertEqual(mac.build_env(),{})
    def test_recorded_python_beats_standard_locations(self):
        with tempfile.TemporaryDirectory() as temp:
            app=Path(temp)/'Local Reader.app';(app/'Contents').mkdir(parents=True)
            with (app/'Contents/Info.plist').open('wb') as f:plistlib.dump({'LocalReaderPython':'/opt/reader-env/bin/python'},f)
            with patch.object(mac,'APP',app),patch.dict(mac.os.environ,{'LOCAL_READER_PYTHON':''}):
                self.assertEqual(mac.default_python(),Path('/opt/reader-env/bin/python'))


class BundlePrefixTests(unittest.TestCase):
    def test_local_override_wins_over_default(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'ios').mkdir()
            self.assertEqual(ios.bundle_prefix(root),'com.ethanniser')
            (root/'ios/Signing.xcconfig').write_text('LOCAL_READER_BUNDLE_PREFIX = com.upstream\n')
            self.assertEqual(ios.bundle_prefix(root),'com.upstream')
            (root/'ios/Signing.local.xcconfig').write_text('// mine\nLOCAL_READER_BUNDLE_PREFIX = com.example.me\nDEVELOPMENT_TEAM = ABCDE12345\n')
            self.assertEqual(ios.bundle_prefix(root),'com.example.me')
            (root/'ios/Signing.local.xcconfig').write_text('LOCAL_READER_BUNDLE_PREFIX = com.first\nLOCAL_READER_BUNDLE_PREFIX = com.example.last // mine\n')
            self.assertEqual(ios.bundle_prefix(root),'com.example.last')


if __name__=='__main__':unittest.main()
