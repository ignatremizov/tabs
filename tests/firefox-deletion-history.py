#!/usr/bin/env python3
"""Actual Firefox deletion/rollback/recovery UI across two disposable processes.

The same NEW marked test profile is reused, never a normal user profile.
Only synthetic pages, containers, notes, and native groups are accessed.
"""
# Copyright (C) 2026 Ignat Remizov; SPDX-License-Identifier: AGPL-3.0-or-later
import argparse
import importlib.util
import http.server
import threading
import json
from pathlib import Path
import shutil

from firefox_driver import FirefoxSession, new_workspace

ROOT = Path(__file__).resolve().parents[1]

SETUP = r"""
const done=arguments[arguments.length-1],origin=arguments[0];
(async()=>{
 const app=(await browser.runtime.getBackgroundPage()).__nativeContextTest;
 await app.treeLoaded;
 await browser.storage.local.set({reorderTabsOnCreate:false,hideCollapsedTabs:false});
 app.tree.reorderTabsOnCreate=false;
 const wait=async(fn,label)=>{const end=Date.now()+15000;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,50));}throw new Error(label+'; groups='+JSON.stringify(await browser.tabGroups.query({}))+'; errors='+JSON.stringify((await browser.runtime.getBackgroundPage()).__nativeContextErrors)+'; nodes='+JSON.stringify(app.tree.root.findNodes(n=>n.nativeGroup).map(n=>({id:n.id,label:n.label,native:n.groupId,kids:n.nodes.map(x=>x.id)}))));};
 const identity=await browser.contextualIdentities.create({name:'Recovery work',color:'green',icon:'briefcase'});
 const tab=await browser.tabs.create({url:origin+'/recovery',cookieStoreId:identity.cookieStoreId,active:false});
 const node=await wait(()=>app.tree.getNodeByTabId(tab.id),'Tab did not attach');
 const groupId=await browser.tabs.group({tabIds:[tab.id],createProperties:{windowId:tab.windowId}});
 await browser.tabGroups.update(groupId,{title:'Deleted research',color:'blue',collapsed:false});
 const group=await wait(()=>node.getNativeGroupNode()?.label==='Deleted research'&&node.getNativeGroupNode(),'Group did not attach');
 const saved=await node.addChild(0,{label:'Saved reference',url:origin+'/saved',note:'Keep this note',checkbox:'🔒',
  cookieStoreId:identity.cookieStoreId,containerProfileId:app.containers.profileId,containerName:identity.name,containerColor:'green',containerIcon:'briefcase'}, {reason:'userAction'});
 const annotation=await saved.addChild(0,{label:'Review reminder',note:'Nested synthetic annotation'}, {reason:'userAction'});
 await group.setExpanded(false,{reason:'userAction'});
 await app.tree.root.flushPendingPersistence();
 const checkpoint={ids:{group:group.id,tab:node.id,saved:saved.id,note:annotation.id},
  parentId:group.parent.id,containerId:identity.cookieStoreId,profileId:app.containers.profileId,tabId:tab.id};
 await browser.storage.local.set({deletionCheckpoint:checkpoint});
 return checkpoint;
})().then(done,e=>done({error:String(e),stack:e.stack}));
"""

DELETE = r"""
const done=arguments[arguments.length-1],checkpoint=arguments[0];
(async()=>{
 const app=(await browser.runtime.getBackgroundPage()).__nativeContextTest;
 const view=window.__isolatedTestTree;
 const {emit}=await import('/common/common.js');
 const {deletionFingerprint}=await import('/common/deletion-history.js');
 const end=Date.now()+15000;
 while(!view.nodes[checkpoint.ids.group]&&Date.now()<end)await new Promise(r=>setTimeout(r,50));
 const target=view.nodes[checkpoint.ids.group];
 if(!target)throw new Error('Fixture absent from view');
 // Inject one transactional storage failure, before a destructive browser API.
 const original=app.tree.db.commitHistoryChange.bind(app.tree.db);
 app.tree.db.commitHistoryChange=async change=>{if(change?.add)throw new Error('Synthetic history disk failure');return original(change);};
 let failed=false;
 try {await view.requestDeletion([{node:target,mode:'branch'}]);}catch{failed=true;}
 finally {app.tree.db.commitHistoryChange=original;}
 if(!failed||!app.tree.nodes[target.id]||!view.nodes[target.id])throw new Error('Failed deletion changed the live outline');
 if(!(await browser.tabs.get(checkpoint.tabId)))throw new Error('Failed deletion closed tab');
 // Expected injected failure is the only background error from this phase.
 const errors=(await browser.runtime.getBackgroundPage()).__nativeContextErrors;
 if(errors.some(line=>!line.includes('Synthetic history disk failure')))throw new Error(errors.join('\n'));
 errors.length=0;
 // A second view must observe the same committed deletion.
 await view.setCursor(target,{scroll:false});
 const oldDialog=view.inputDialog;view.inputDialog=async()=>({button:'OK'});
 try {await view.runUiAction('Delete fixture group',()=>view.action_deleteNode({type:'command'}));}
 finally {view.inputDialog=oldDialog;}
 if(app.tree.nodes[target.id])throw new Error('Deletion did not complete');
 const history=await emit('bkgd_listDeleted');
 if(history.entries.length!==1||history.entries[0].nodeCount!==4)throw new Error('History action was not complete');
 checkpoint.entryId=history.entries[0].id;
 await browser.storage.local.set({deletionCheckpoint:checkpoint});
 let exists=true;try{await browser.tabs.get(checkpoint.tabId);}catch{exists=false;}
 if(exists)throw new Error('Committed deletion did not close tab');
 if(app.tree.nodes[target.id])throw new Error('Background still has deleted node');
 return {checkpoint,rollbackVerified:true,deletedCount:history.entries[0].nodeCount};
})().then(done,e=>done({error:String(e),stack:e.stack}));
"""

VERIFY = r"""
const done=arguments[arguments.length-1];
(async()=>{
 const bg=await browser.runtime.getBackgroundPage(),app=bg.__nativeContextTest;
 await app.treeLoaded;
 const {deletionCheckpoint:c}=await browser.storage.local.get('deletionCheckpoint');
 const {emit}=await import('/common/common.js');
 const history=await emit('bkgd_listDeleted');
 if(history.entries.length!==1||history.entries[0].id!==c.entryId)throw new Error('Persistent history missing after process restart');
 for(const id of Object.values(c.ids))if(app.tree.nodes[id])throw new Error('Deleted outline records reappeared');
 return {checkpoint:c,historySurvived:true,tabCount:(await browser.tabs.query({})).length};
})().then(done,e=>done({error:String(e),stack:e.stack}));
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--geckodriver', default=shutil.which('geckodriver'))
    args = parser.parse_args()
    if not args.geckodriver:
        parser.error('geckodriver is required')
    spec = importlib.util.spec_from_file_location('history_native', ROOT / 'tests/firefox-native-context.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    work = new_workspace(args.geckodriver)
    package = native.stage_extension(work, expose_views=True)
    prefs = {'browser.startup.page': 0}
    profile = work / 'profile'
    args.output.mkdir(parents=True, exist_ok=True)
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),native.FixtureServer)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with FirefoxSession(args.geckodriver, work, args.output / 'before', profile=profile, prefs=prefs) as first:
            addon_id = first.install(package)
            base = first.addon_url(addon_id)
            first.navigate(base + 'view/sidepanel.html')
            first.wait('return window.__isolatedTestTree?.presentationStateReady;')
            first_handle = first.command('GET', 'window')
            checkpoint = first.script(SETUP, f'http://127.0.0.1:{server.server_port}', asynchronous=True)
            second_handle = first.command('POST', 'window/new', {'type':'tab'})['handle']
            first.command('POST', 'window', {'handle':second_handle})
            first.navigate(base + 'view/sidepanel.html')
            first.wait('return window.__isolatedTestTree?.presentationStateReady;')
            first.command('POST', 'window', {'handle':first_handle})
            result = first.script(DELETE, checkpoint, asynchronous=True)
            checkpoint = result['checkpoint']
            first.command('POST', 'window', {'handle':second_handle})
            first.script('window.__deletedId=arguments[0];', checkpoint['ids']['group'])
            first.wait('return !window.__isolatedTestTree.nodes[window.__deletedId];')
            first.navigate(base + 'view/deleted.html')
            first.wait("return document.querySelectorAll('.history-entry').length === 1;")
            first.screenshot('recently-deleted.png')
            first.command('POST','window/rect',{'width':390,'height':850})
            first.screenshot('recently-deleted-narrow.png')
            first.script("if(document.documentElement.scrollWidth>innerWidth+1)throw new Error('History page overflows narrow window');")
            first.command('POST','window/rect',{'width':1250,'height':950})
            first.script("document.querySelector('#history-settings').open=true;")
            first.screenshot('retention-settings.png')
            first.script("document.querySelector('[data-action=purge]').click();")
            first.wait("return document.querySelector('#history-confirm').open;")
            first.screenshot('permanent-removal-confirmation.png')
            first.script("document.querySelector('#history-confirm button[value=cancel]').click();")
            first.wait("return !document.querySelector('#history-confirm').open;")
            first.script("if(document.querySelectorAll('.history-entry').length!==1)throw new Error('Cancel removed history');")
            first.script("return browser.storage.local.set({theme:'TK Day'});")
            first.wait("return document.querySelector('#theme-variant').href.includes('tk-day.css');")
            first.screenshot('retention-settings-day.png')
            first.script("return browser.storage.local.set({theme:'TK Night'});")
            old_pid = first.capabilities['moz:processID']
        with FirefoxSession(args.geckodriver, work, args.output / 'after', profile=profile, prefs=prefs) as second:
            assert second.capabilities['moz:processID'] != old_pid
            second.install(package)
            base = second.addon_url(addon_id)
            second.navigate(base + 'view/deleted.html')
            second.wait("return document.querySelectorAll('.history-entry').length === 1;")
            before = second.script(VERIFY, asynchronous=True)
            second.script("document.querySelector('[data-action=restore]').click();")
            second.wait("return document.querySelector('#history-status').textContent.includes('No pages were opened');")
            restored = second.script(r"""
              const done=arguments[arguments.length-1],before=arguments[0];
              (async()=>{
                const bg=await browser.runtime.getBackgroundPage(),app=bg.__nativeContextTest;
                const {deletionCheckpoint:c}=await browser.storage.local.get('deletionCheckpoint');
                const tree=app.tree,group=tree.nodes[c.ids.group],tab=tree.nodes[c.ids.tab],saved=tree.nodes[c.ids.saved],note=tree.nodes[c.ids.note];
                if(!group?.nativeGroup||group.groupId!=null||group.groupColor!=='blue'||group.label!=='Deleted research'||!group.groupCollapsed)throw new Error('Group metadata lost');
                if(tab.parent!==group||saved.parent!==tab||note.parent!==saved)throw new Error('Nesting lost');
                if(tab.loaded||saved.loaded||tab.tabId||saved.tabId||tab.windowId)throw new Error('Restore retained live bindings');
                if(saved.checkbox!=='🔒'||saved.note!=='Keep this note'||note.note!=='Nested synthetic annotation')throw new Error('Saved metadata lost');
                if(tab.cookieStoreId!==c.containerId||saved.cookieStoreId!==c.containerId||tab.containerProfileId!==c.profileId)throw new Error('Container changed');
                if((await browser.tabs.query({})).length!==before.tabCount)throw new Error('Restore opened a tab');
                const {emit}=await import('/common/common.js');
                const repeated=await emit('bkgd_restoreDeleted',{entryId:c.entryId});
                if(!repeated.alreadyRestored)throw new Error('Restore retry duplicated data');
                if(bg.__nativeContextErrors.length)throw new Error(bg.__nativeContextErrors.join('\n'));
                return {ancestry:true,container:true,notesAndCheckbox:true,savedOnly:true,idempotent:true};
              })().then(done,e=>done({error:String(e),stack:e.stack}));
            """, before, asynchronous=True)
            promoted = second.script(r"""
              const done=arguments[arguments.length-1],origin=arguments[0];
              (async()=>{
                const app=(await browser.runtime.getBackgroundPage()).__nativeContextTest;
                const {emit}=await import('/common/common.js');
                const {deletionFingerprint}=await import('/common/deletion-history.js');
                const tab=await browser.tabs.create({url:origin+'/promoted',active:false});
                const groupId=await browser.tabs.group({tabIds:[tab.id],createProperties:{windowId:tab.windowId}});
                await browser.tabGroups.update(groupId,{title:'Remove only the group',color:'purple'});
                const end=Date.now()+15000;
                let node,group;
                while(Date.now()<end){node=app.tree.getNodeByTabId(tab.id);group=node?.getNativeGroupNode();if(group?.label==='Remove only the group')break;await new Promise(r=>setTimeout(r,50));}
                if(!group)throw new Error('Group-only fixture did not attach');
                const parentId=group.parent.id;
                // Startup can reopen an old internal extension page after
                // readiness. Respect the real pending-load barrier, just as
                // a user is asked to do, rather than racing that restoration.
                const settled=Date.now()+15000;
                while(app.activeBrowserCreates||app.nodesLoading.length||app.windowsLoading.length){
                  if(Date.now()>settled)throw new Error('Native restore did not settle');
                  await new Promise(resolve=>setTimeout(resolve,50));
                }
                await emit('bkgd_deleteSelection',{entryId:'group-only-fixture',items:[{nodeId:group.id,mode:'promoteKids',fingerprint:await deletionFingerprint(group,'promoteKids')}]});
                if(app.tree.nodes[group.id]||node.parent.id!==parentId)throw new Error('Group-only deletion lost promotion');
                if((await browser.tabs.get(tab.id)).groupId>=0)throw new Error('Native group was not removed');
                await app.tabGroups.sync();
                if(app.tree.nodes[group.id]||node.getNativeGroupNode())throw new Error('Removed group was recreated');
                const result=await emit('bkgd_restoreDeleted',{entryId:'group-only-fixture'});
                if(result.restored!==1||app.tree.nodes[group.id].nodes.length||node.getNativeGroupNode())throw new Error('Group-only recovery stole surviving members');
                if(!(await browser.tabs.get(tab.id)))throw new Error('Promoted member was closed');
                return {liveMemberPreserved:true,nativeUngrouped:true,savedNoteOnly:true};
              })().then(done,e=>done({error:String(e),stack:e.stack}));
            """, f'http://127.0.0.1:{server.server_port}', asynchronous=True)
            second.screenshot('after-restore.png')
            summary = {'passed':True,'firefox':second.capabilities['browserVersion'],'workspace':str(work),
                'rollbackVerified':result['rollbackVerified'],'twoViewsConverged':True,
                'fullProcessRestart':True,'historySurvived':before['historySurvived'],
                'realRestoreButton':True,'restored':restored,'groupOnlyRecovery':promoted}
            (args.output/'results.json').write_text(json.dumps(summary,indent=2))
            print(json.dumps(summary,indent=2))
    finally:
        server.shutdown(); server.server_close()
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
