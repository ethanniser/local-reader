#!/usr/bin/env python3
"""Build and reinstall Local Reader on one explicitly selected iPhone; never uninstall it."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile

def bundle_prefix(source=Path(__file__).resolve().parent.parent):
    """LOCAL_READER_BUNDLE_PREFIX from ios/Signing.local.xcconfig, else ios/Signing.xcconfig."""
    for name in ('Signing.local.xcconfig','Signing.xcconfig'):
        try: text=(source/'ios'/name).read_text()
        except OSError: continue
        text=re.sub(r'//.*','',text)  # xcconfig comments; the last assignment wins, as in Xcode
        matches=re.findall(r'^\s*LOCAL_READER_BUNDLE_PREFIX\s*=\s*([A-Za-z0-9.-]+)\s*$',text,re.M)
        if matches: return matches[-1]
    return 'com.ethanniser'



def commands(source,device,team,derived,provisioning=False):
    build=['xcodebuild','-project',str(source/'ios/LocalReader.xcodeproj'),'-scheme','LocalReader','-configuration','Debug',
           '-destination','id='+device,'-derivedDataPath',str(derived),'DEVELOPMENT_TEAM='+team,'CODE_SIGN_STYLE=Automatic','build']
    if provisioning: build[-1:-1]=['-allowProvisioningUpdates','-allowProvisioningDeviceRegistration']
    return [[str(source/'ios/prepare.sh')],build,['xcrun','devicectl','device','install','app','--device',device,str(derived/'Build/Products/Debug-iphoneos/LocalReader.app')]]


def execute(command,source):
    path=str(Path.home()/'.bun/bin')+os.pathsep+os.environ.get('PATH','/usr/bin:/bin:/usr/sbin:/sbin')
    result=subprocess.run(command,cwd=source,env={**os.environ,'PATH':path,'GIT_TERMINAL_PROMPT':'0'},
                          stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=1800)
    if result.returncode:
        # Provisioning tools can emit account identifiers; retain no broad log.
        raise RuntimeError(Path(command[0]).name+' failed. Your installed app was not removed. Check device trust, selected team, provisioning, and Xcode setup.')


def verify_source(source,revision):
    head=subprocess.run(['git','-C',str(source),'rev-parse','HEAD'],capture_output=True,text=True,timeout=30)
    status=subprocess.run(['git','-C',str(source),'status','--porcelain','--untracked-files=normal'],capture_output=True,text=True,timeout=30)
    if head.returncode or status.returncode or head.stdout.strip()!=revision or status.stdout.strip():
        raise RuntimeError('Source must be clean at the exact reviewed revision. No phone installation was attempted.')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device',required=True,help='Explicit physical iPhone device identifier shown by Xcode/devicectl.')
    parser.add_argument('--team',required=True,help='Your explicit 10-character Apple development team ID.')
    parser.add_argument('--revision',required=True,help='Exact reviewed full Git commit SHA to build from this checkout.')
    parser.add_argument('--source',type=Path,default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--allow-provisioning',action='store_true',help='Allow Xcode to manage provisioning and register the selected device with the chosen team.')
    parser.add_argument('--dry-run',action='store_true',help='Check prerequisites and print commands without downloading/building/installing.')
    args=parser.parse_args();source=args.source.expanduser().resolve();BUNDLE_ID=bundle_prefix(source)+'.localreader'
    if not re.fullmatch(r'[A-Za-z0-9-]{8,100}',args.device): parser.error('Use the explicit device identifier from Xcode.')
    if not re.fullmatch(r'[A-Z0-9]{10}',args.team): parser.error('Team ID must contain 10 uppercase letters/digits.')
    if not re.fullmatch(r'[0-9a-f]{40,64}',args.revision): parser.error('Revision must be a full lowercase Git commit SHA.')
    try:
        for tool in ('xcodebuild','xcrun','xcodegen','git'):
            if not shutil.which(tool): raise RuntimeError('Required command is missing: '+tool)
        if not (source/'ios/prepare.sh').is_file(): raise RuntimeError('Choose the Local Reader source repository.')
        verify_source(source,args.revision)
        if args.dry_run:
            plan=commands(source,args.device,args.team,Path('/tmp/local-reader-ios-update-preview'),args.allow_provisioning)
            print(json.dumps({'dryRun':True,'bundleIdentifier':BUNDLE_ID,'commands':plan,'message':'No build or installation performed.'}));return 0
        with tempfile.TemporaryDirectory(prefix='local-reader-ios-update-') as temporary:
            derived=Path(temporary);plan=commands(source,args.device,args.team,derived,args.allow_provisioning)
            print('Preparing pinned SDK and building for the selected phone/team…',file=sys.stderr)
            execute(plan[0],source);execute(plan[1],source)
            built=derived/'Build/Products/Debug-iphoneos/LocalReader.app'
            with (built/'Info.plist').open('rb') as stream:info=plistlib.load(stream)
            if info.get('CFBundleIdentifier') != BUNDLE_ID: raise RuntimeError('Unexpected bundle ID; refusing to install a different app.')
            signed=subprocess.run(['codesign','-dv','--verbose=4',str(built)],capture_output=True,text=True,timeout=30)
            if signed.returncode or ('TeamIdentifier='+args.team) not in signed.stderr.splitlines():
                raise RuntimeError('The built app is not signed by the explicitly selected team; installation cancelled.')
            verify_source(source,args.revision)
            print('Installing over the same app; its data is not uninstalled…',file=sys.stderr)
            execute(plan[2],source)
            print(json.dumps({'success':True,'bundleIdentifier':BUNDLE_ID,'version':info.get('CFBundleShortVersionString'),
                              'build':info.get('CFBundleVersion'),'message':'Installed on the selected iPhone. Open Local Reader to verify the library and playback.'}));return 0
    except Exception as error:
        message=str(error) if isinstance(error,RuntimeError) else 'Update could not complete. The updater never uninstalls your phone app.'
        print(json.dumps({'success':False,'error':message}));return 1


if __name__=='__main__':sys.exit(main())
