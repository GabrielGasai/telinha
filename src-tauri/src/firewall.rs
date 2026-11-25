// Libera o Telinha no Firewall do Windows (uma vez só).
//
// A ponte recebe conexões de quem está do outro lado da internet. Sem uma regra
// no firewall, o Windows bloqueia essas conexões. Criar a regra precisa de
// permissão de administrador, então o Windows mostra aquela janela
// "Permitir que este app faça alterações?" na primeira vez.

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    const RULE: &str = "Telinha";
    const NO_WINDOW: u32 = 0x0800_0000;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // A regra do Telinha já existe?
    fn has_rule() -> bool {
        Command::new("netsh")
            .args([
                "advfirewall",
                "firewall",
                "show",
                "rule",
                &format!("name={RULE}"),
            ])
            .creation_flags(NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    pub fn ensure() -> Result<bool, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_string_lossy().to_string();
        if has_rule() {
            return Ok(true);
        }
        // Apaga regras antigas (de outra pasta) e cria a nova, num único pedido de permissão.
        let params = format!(
            "/c netsh advfirewall firewall delete rule name=\"{RULE}\" & netsh advfirewall firewall add rule name=\"{RULE}\" dir=in action=allow program=\"{exe}\" enable=yes profile=any"
        );
        let verb = wide("runas");
        let file = wide("cmd.exe");
        let params = wide(&params);
        unsafe {
            let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            info.fMask = SEE_MASK_NOCLOSEPROCESS;
            info.lpVerb = verb.as_ptr();
            info.lpFile = file.as_ptr();
            info.lpParameters = params.as_ptr();
            info.nShow = SW_HIDE as i32;
            if ShellExecuteExW(&mut info) == 0 {
                // A pessoa clicou em "Não" ou o Windows não deixou.
                return Ok(false);
            }
            if !info.hProcess.is_null() {
                WaitForSingleObject(info.hProcess, 30_000);
                CloseHandle(info.hProcess);
            }
        }
        Ok(has_rule())
    }
}

/// Garante que o Telinha pode receber conexões. Devolve true se está liberado.
#[tauri::command]
pub async fn ensure_firewall() -> Result<bool, String> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(imp::ensure)
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        Ok(true)
    }
}
