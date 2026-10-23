use super::*;
use std::sync::atomic::AtomicUsize;

fn root() -> std::path::PathBuf { std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".tmp/r44d-own-native") }
fn wake(app: &tauri::AppHandle) -> std::sync::Arc<AtomicBool> {
    let stop=std::sync::Arc::new(AtomicBool::new(false)); let gate=stop.clone(); let app=app.clone();
    std::thread::spawn(move || { while !gate.load(Ordering::Acquire) { std::thread::sleep(std::time::Duration::from_millis(80)); let _=app.run_on_main_thread(||{}); } });
    stop
}
fn make_window(app: &tauri::AppHandle, label: &str, title: &str, transparent: bool) -> tauri::WebviewWindow {
    let dir=root().join(label); std::fs::create_dir_all(&dir).unwrap();
    let url=if label=="lyrics" { "lyrics.html?mode=taskbar&size=md&theme=light" } else { "index.html" };
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url.into()))
        .title(title).inner_size(700.0,140.0).position(200.0,200.0).decorations(false).shadow(false)
        .transparent(transparent).visible(true).data_directory(dir).build().unwrap()
}

#[test]
fn d_native_parent_process() {
    if std::env::var("HWMUSIC_D_PARENT").ok().as_deref()!=Some("1") { return; }
    std::fs::create_dir_all(root()).unwrap();
    let clicks=std::sync::Arc::new(AtomicUsize::new(0));
    let app=tauri::Builder::default().any_thread().build(tauri::generate_context!()).unwrap();
    let main=make_window(app.handle(),"main","D review own parent",false);
    main.set_always_on_top(true).unwrap(); main.set_focus().unwrap();
    let counter=clicks.clone(); let last=std::sync::Arc::new(AtomicBool::new(false)); let pending=last.clone();
    let parent_view=main.clone();
    let ticker_view=main.clone();
    let count=clicks.clone(); main.on_window_event(move |_| { let _=&count; });
    unsafe extern "system" fn parent_proc(h:HWND,m:u32,w:windows::Win32::Foundation::WPARAM,l:windows::Win32::Foundation::LPARAM,id:usize,data:usize)->windows::Win32::Foundation::LRESULT {
        if m==WM_LBUTTONDOWN { (*(data as *const AtomicUsize)).fetch_add(1,Ordering::AcqRel); }
        if m==WM_NCDESTROY { let _=windows::Win32::UI::Shell::RemoveWindowSubclass(h,Some(parent_proc),id); }
        windows::Win32::UI::Shell::DefSubclassProc(h,m,w,l)
    }
    let handle=HWND(main.hwnd().unwrap().0);
    unsafe { assert!(windows::Win32::UI::Shell::SetWindowSubclass(handle,Some(parent_proc),700,std::sync::Arc::as_ptr(&clicks) as usize).as_bool()); }
    std::fs::write(root().join("parent.json"),json!({"pid":std::process::id(),"hwnd":handle.0 as isize}).to_string()).unwrap();
    let stop=root().join("stop-parent"); let receipts=root().join("parent-clicks"); let started=Instant::now();
    let ticker=wake(app.handle()); let mut exiting=false; let mut front=false;
    app.run_return(move |app,_| {
        if !pending.swap(true,Ordering::AcqRel) {
            let counter=counter.clone(); let pending=pending.clone();
            parent_view.eval_with_callback("window.__dClicks??=0;if(!window.__dListening){document.addEventListener('mousedown',()=>{window.__dClicks++},true);window.__dListening=true;}String(window.__dClicks)", move |s| { let value:Value=serde_json::from_str(&s).unwrap_or(json!("0")); let n=value.as_str().unwrap_or("0").parse::<usize>().unwrap_or(0); counter.store(n,Ordering::Release); pending.store(false,Ordering::Release); }).unwrap();
        }
        if !front && root().join("ready-child").exists() { front=true; ticker_view.set_always_on_top(false).unwrap(); ticker_view.set_always_on_top(true).unwrap(); ticker_view.set_focus().unwrap(); std::fs::write(root().join("front-parent"),"own parent front").unwrap(); }
        let _=std::fs::write(&receipts,clicks.load(Ordering::Acquire).to_string());
        if !exiting && (stop.exists() || started.elapsed()>std::time::Duration::from_secs(90)) { exiting=true; ticker.store(true,Ordering::Release); let _=main.destroy(); app.exit(0); }
    });
}

#[tauri::command]
async fn core_lyrics_configure(webview: tauri::Webview, config: Value) -> Result<Value, crate::bridge::CoreError> {
    crate::lyrics_window::validate_configure(webview.label(), &config, None)?;
    let config=crate::lyrics_window::LyricsConfig::default().apply_patch(&json!({"mode":"taskbar","size":"md"}));
    Ok(json!({"config":config.payload(),"revision":1,"runtimeRevision":1,"visible":false}))
}

#[test]
fn d_native_tauri_child_process() {
    if std::env::var("HWMUSIC_D_CHILD").ok().as_deref()!=Some("1") { return; }
    let parent:Value=serde_json::from_str(&std::fs::read_to_string(root().join("parent.json")).unwrap()).unwrap();
    let parent_id=identity(hwnd(parent["hwnd"].as_i64().unwrap() as isize)).unwrap();
    assert_eq!(parent_id.pid,u32::try_from(parent["pid"].as_u64().unwrap()).unwrap());
    let app=tauri::Builder::default().any_thread().invoke_handler(tauri::generate_handler![core_lyrics_configure]).build(tauri::generate_context!()).unwrap();
    app.manage(Host::default());
    let main=make_window(app.handle(),"main","D review child observer",false); main.hide().unwrap();
    observe_main(app.handle()).unwrap();
    let lyrics=make_window(app.handle(),"lyrics","D review own lyrics",true); lyrics.hide().unwrap();
    let host=app.state::<Host>(); host.register(&lyrics,1,true,true,0).unwrap();
    let content=std::sync::Arc::new(AtomicBool::new(false)); let ink=std::sync::Arc::new(AtomicBool::new(false));
    let context=app.handle().clone(); let ready=content.clone();
    let owned=lyrics.clone();
    let started=Instant::now(); let mut phase=0; let done=root().join("finish-child");
    let result=root().join("child.json"); let gate=ready.clone(); let screenshot=ink.clone();
    let ticker=wake(app.handle());
    app.run_return(move |app,_| {
        if started.elapsed()>std::time::Duration::from_secs(45) { ticker.store(true,Ordering::Release); panic!("native child verification timed out"); }
        let host=context.state::<Host>();
        if phase==0 && started.elapsed()>std::time::Duration::from_secs(2) {
            let target=TargetSnapshot { shell:parent_id,parent:parent_id,client_screen:client_screen(hwnd(parent_id.handle)).unwrap(),monitor:0,monitor_rect:PixelRect{x:0,y:0,width:1920,height:1080},dpi:96,dpi_context:-4 };
            let mut inner=lock(&host.inner); let token=inner.policy.live().unwrap();
            prepare_child(&mut inner,token,&target,PixelRect{x:20,y:20,width:600,height:44},&owned).unwrap();
            assert_eq!(unsafe{GetClassLongPtrW(hwnd(token.handle),GCL_STYLE)} as u32 & CS_OWNDC.0, CS_OWNDC.0);
            assert_eq!(unsafe{get_long(hwnd(token.handle),GWL_EXSTYLE)}.unwrap() & 0x80000,0);
            assert!(!unsafe{windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled(hwnd(token.handle))}.as_bool());
            unsafe { let _=ShowWindow(ensure_own(&inner.policy,token).unwrap(),SW_SHOWNOACTIVATE); }
            phase=1;
        }
        if phase==1 {
            crate::commands::emit_core_event(app,crate::bridge::LYRICS_DOCUMENT,json!({"status":"ready","lines":[{"startTime":0,"endTime":10000,"words":[{"word":"TASKBAR OWN LYRICS 123","startTime":0,"endTime":10000}],"translatedLyric":"","romanLyric":"","isBG":false,"isDuet":false}]}));
            crate::commands::emit_core_event(app,crate::bridge::LYRICS_PROGRESS,json!({"timeMs":2000,"playing":false,"seekGeneration":1}));
            let verify=gate.clone(); owned.eval_with_callback("JSON.stringify({w:innerWidth,h:innerHeight,text:document.body.textContent.includes('TASKBAR OWN LYRICS')})",move |s| { std::fs::write(root().join("viewport.json"),&s).unwrap(); let mut v:Value=serde_json::from_str(&s).unwrap(); if let Some(text)=v.as_str(){v=serde_json::from_str(text).unwrap();} if v["w"]==600 && v["h"]==44 && v["text"]==true { verify.store(true,Ordering::Release); } }).unwrap();
            let token=host.live().unwrap();
            let root=client_screen(hwnd(token.handle)).unwrap();
            std::fs::write(&result,json!({"pid":std::process::id(),"hwnd":token.handle,"parent":parent_id.handle,"rect":[root.x,root.y,root.width,root.height],"layered":false,"disabled":true}).to_string()).unwrap();
            phase=1;
        }
        if phase==1 && gate.load(Ordering::Acquire) {
            // Exercise the installed top-level observer and the real lyrics child parent-DPI messages.
            let own_main=HWND(main.hwnd().unwrap().0); let child=host.live().unwrap();
            unsafe { let _=SendMessageW(own_main,RegisterWindowMessageW(w!("TaskbarCreated")),None,None); }
            assert!(host.changed.swap(false,Ordering::AcqRel));
            for msg in [WM_DISPLAYCHANGE,WM_DPICHANGED_BEFOREPARENT,WM_DPICHANGED_AFTERPARENT] {
                unsafe { let _=SendMessageW(hwnd(child.handle),msg,None,None); }
                assert!(host.changed.swap(false,Ordering::AcqRel));
            }
            screenshot.store(true,Ordering::Release); phase=2;
            std::fs::write(root().join("ready-child"),"viewport=600x44; own-top-and-child-message-bridge=ok").unwrap();
        }
        if phase==2 && done.exists() {
            let mut i=lock(&host.inner); let token=i.policy.live().unwrap();
            hide(&i.policy,token).unwrap();
            if let Some(saved)=i.resources.saved_for(token) { let result=restore(&i.policy,saved); std::fs::write(root().join("restore.json"),json!({"result":format!("{result:?}"),"savedParent":saved.parent,"actualParent":unsafe{GetParent(hwnd(token.handle))}.ok().map(|h|h.0 as isize).unwrap_or(0),"style":unsafe{get_long(hwnd(token.handle),GWL_STYLE)}.unwrap_or(0)}).to_string()).unwrap(); assert!(result.is_ok()); i.resources.clear_saved(token); }
            i.policy.detached(); drop(i);
            assert!(screenshot.load(Ordering::Acquire));
            phase=3; ticker.store(true,Ordering::Release); let _=owned.destroy(); let _=main.destroy(); app.exit(0);
        }
    });
}
