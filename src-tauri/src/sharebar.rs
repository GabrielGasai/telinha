//! Esconde a barra flutuante do WebView2 "... está compartilhando sua tela".
//!
//! O WebView2 não tem opção para desligar essa barra, então, logo depois que a
//! captura começa, procuramos a janelinha dela (pertence ao processo
//! msedgewebview2.exe, é da classe Chrome_WidgetWin_1 e é baixinha) e a
//! escondemos. A transmissão continua normal; o botão "Parar" do app segue valendo.

#[tauri::command]
pub fn hide_share_bar() {
    #[cfg(windows)]
    std::thread::spawn(|| {
        // Procura por ~12 s, porque a barra só aparece depois que a pessoa escolhe a tela.
        for _ in 0..80 {
            std::thread::sleep(std::time::Duration::from_millis(150));
            unsafe { win::hide_once() };
        }
    });
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
        ShowWindow, SW_HIDE,
    };

    pub unsafe fn hide_once() {
        EnumWindows(Some(check_window), 0);
    }

    unsafe extern "system" fn check_window(hwnd: HWND, _: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
        if n <= 0 || String::from_utf16_lossy(&class[..n as usize]) != "Chrome_WidgetWin_1" {
            return 1;
        }
        let mut r: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut r) == 0 {
            return 1;
        }
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        if h < 20 || h > 120 || w > 1000 {
            return 1;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 || pid == std::process::id() {
            return 1;
        }
        if is_webview2(pid) {
            ShowWindow(hwnd, SW_HIDE);
        }
        1
    }

    unsafe fn is_webview2(pid: u32) -> bool {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        ok != 0
            && String::from_utf16_lossy(&buf[..len as usize])
                .to_lowercase()
                .ends_with("msedgewebview2.exe")
    }
}
