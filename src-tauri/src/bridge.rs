// Ponte (servidor TURN) dentro do próprio Telinha.
//
// Quando duas internets não conseguem se ligar direto (operadora/roteador
// restrito), o vídeo e o áudio podem passar pelo PC de alguém da sala que tenha
// internet de casa comum. Para isso o Telinha:
//   1. pede ao roteador (UPnP) para abrir algumas portas UDP para este PC;
//   2. roda um servidor TURN pequeno nessas portas;
//   3. devolve endereço e senha para o app avisar a sala (cifrado).
// Nada disso usa servidor de fora: é a internet de quem é a ponte.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket as StdUdpSocket};
use std::sync::Arc;
use std::time::Duration;

use igd_next::{Gateway, PortMappingProtocol, SearchOptions};
use serde::Serialize;
use tokio::sync::Mutex;
use turn::auth::{generate_auth_key, AuthHandler};
use turn::relay::relay_range::RelayAddressGeneratorRanges;
use turn::server::config::{ConnConfig, ServerConfig};
use turn::server::Server;
use webrtc_util::vnet::net::Net;

const REALM: &str = "telinha";
const USER: &str = "telinha";
// Porta principal da ponte e faixa usada para repassar o vídeo/áudio.
const MAIN_PORTS: [u16; 3] = [3478, 3479, 3480];
const RELAY_MIN: u16 = 49_400;
const RELAY_MAX: u16 = 49_415;
// O roteador mantém as portas abertas por 2 horas (renovado ao entrar de novo).
const LEASE_SECS: u32 = 7200;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub ok: bool,
    /// Motivo quando não deu: "sem-roteador", "cgnat", "porta", "erro".
    pub reason: String,
    pub public_ip: String,
    pub lan_ip: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
}

struct Running {
    server: Server,
    gateway: Gateway,
    mapped: Vec<u16>,
    info: BridgeInfo,
}

#[derive(Default)]
pub struct BridgeState(Mutex<Option<Running>>);

struct Auth {
    keys: HashMap<String, Vec<u8>>,
}

impl AuthHandler for Auth {
    fn auth_handle(
        &self,
        username: &str,
        _realm: &str,
        _src: SocketAddr,
    ) -> Result<Vec<u8>, turn::Error> {
        self.keys
            .get(username)
            .cloned()
            .ok_or(turn::Error::ErrFakeErr)
    }
}

fn fail(reason: &str) -> BridgeInfo {
    BridgeInfo {
        reason: reason.into(),
        ..Default::default()
    }
}

// IP deste PC na rede de casa (sem mandar nada pela internet).
fn lan_ip() -> Option<Ipv4Addr> {
    let s = StdUdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        _ => None,
    }
}

// Endereço que dá para alcançar da internet (não é de rede interna nem CGNAT).
fn is_public(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || (o[0] == 100 && (64..=127).contains(&o[1])))
        }
        IpAddr::V6(_) => false,
    }
}

fn random_pass() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i ^ std::process::id() as u64);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn open_ports(gw: &Gateway, lan: Ipv4Addr) -> Result<(u16, Vec<u16>), String> {
    let mut mapped = Vec::new();
    let mut main = None;
    for p in MAIN_PORTS {
        if gw
            .add_port(
                PortMappingProtocol::UDP,
                p,
                SocketAddr::V4(SocketAddrV4::new(lan, p)),
                LEASE_SECS,
                "Telinha",
            )
            .is_ok()
        {
            mapped.push(p);
            main = Some(p);
            break;
        }
    }
    let main = main.ok_or("porta")?;
    for p in RELAY_MIN..=RELAY_MAX {
        if gw
            .add_port(
                PortMappingProtocol::UDP,
                p,
                SocketAddr::V4(SocketAddrV4::new(lan, p)),
                LEASE_SECS,
                "Telinha",
            )
            .is_ok()
        {
            mapped.push(p);
        }
    }
    Ok((main, mapped))
}

fn close_ports(gw: &Gateway, ports: &[u16]) {
    for p in ports {
        let _ = gw.remove_port(PortMappingProtocol::UDP, *p);
    }
}

/// Liga a ponte (se ainda não estiver ligada) e diz se deu certo.
#[tauri::command]
pub async fn start_bridge(state: tauri::State<'_, BridgeState>) -> Result<BridgeInfo, String> {
    let mut guard = state.0.lock().await;
    if let Some(r) = guard.as_ref() {
        return Ok(r.info.clone());
    }

    let lan = match lan_ip() {
        Some(ip) => ip,
        None => return Ok(fail("erro")),
    };

    // Procurar o roteador e abrir as portas (operações que travam: fora da thread principal).
    let found = tokio::task::spawn_blocking(
        move || -> Result<(Gateway, IpAddr, u16, Vec<u16>), String> {
            let mut opts = SearchOptions::default();
            opts.timeout = Some(Duration::from_secs(4));
            let gw = igd_next::search_gateway(opts).map_err(|_| "sem-roteador".to_string())?;
            let ext = gw
                .get_external_ip()
                .map_err(|_| "sem-roteador".to_string())?;
            if !is_public(&ext) {
                return Err("cgnat".into());
            }
            let (main, mapped) = open_ports(&gw, lan)?;
            Ok((gw, ext, main, mapped))
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    let (gateway, ext, port, mapped) = match found {
        Ok(v) => v,
        Err(reason) => return Ok(fail(&reason)),
    };

    let pass = random_pass();
    let mut keys = HashMap::new();
    keys.insert(USER.to_string(), generate_auth_key(USER, REALM, &pass));

    let conn = match tokio::net::UdpSocket::bind(("0.0.0.0", port)).await {
        Ok(c) => Arc::new(c),
        Err(_) => {
            close_ports(&gateway, &mapped);
            return Ok(fail("porta"));
        }
    };

    let server = Server::new(ServerConfig {
        conn_configs: vec![ConnConfig {
            conn,
            relay_addr_generator: Box::new(RelayAddressGeneratorRanges {
                relay_address: ext,
                min_port: RELAY_MIN,
                max_port: RELAY_MAX,
                max_retries: 30,
                address: "0.0.0.0".to_owned(),
                net: Arc::new(Net::new(None)),
            }),
        }],
        realm: REALM.to_owned(),
        auth_handler: Arc::new(Auth { keys }),
        channel_bind_timeout: Duration::from_secs(0),
        alloc_close_notify: None,
    })
    .await;

    let server = match server {
        Ok(s) => s,
        Err(_) => {
            close_ports(&gateway, &mapped);
            return Ok(fail("erro"));
        }
    };

    let info = BridgeInfo {
        ok: true,
        reason: String::new(),
        public_ip: ext.to_string(),
        lan_ip: lan.to_string(),
        port,
        user: USER.into(),
        pass,
    };
    *guard = Some(Running {
        server,
        gateway,
        mapped,
        info: info.clone(),
    });
    Ok(info)
}

/// Desliga a ponte e fecha as portas no roteador.
#[tauri::command]
pub async fn stop_bridge(state: tauri::State<'_, BridgeState>) -> Result<(), String> {
    let running = state.0.lock().await.take();
    if let Some(r) = running {
        let _ = r.server.close().await;
        let gw = r.gateway;
        let ports = r.mapped;
        let _ = tokio::task::spawn_blocking(move || close_ports(&gw, &ports)).await;
    }
    Ok(())
}
