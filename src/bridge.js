// Ponte automática entre internets que não conseguem se ligar direto.
//
// Quem tem internet de casa comum liga uma ponte (servidor TURN dentro do
// próprio Telinha, ver src-tauri/src/bridge.rs) e avisa a sala pelos mesmos
// servidores de encontro do Nostr. O aviso vai cifrado com o código da sala,
// então só quem está na sala lê. Quem recebe o aviso passa a tentar também o
// caminho pela ponte quando a ligação direta não funciona.
import { schnorr } from '@noble/curves/secp256k1'
import { ICE_SERVERS } from './config.js'

const VERSION = 'v1'
const KIND = 22533 // evento "efêmero" do Nostr: os servidores repassam e não guardam
const ANNOUNCE_MS = 8000
const MAX_BRIDGES = 3

const enc = new TextEncoder()
const dec = new TextDecoder()
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const b64 = (b) => btoa(String.fromCharCode(...b))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data))

// Endereço da minha ponte (para corrigir o caminho quando eu falo com ela mesma).
let mine = null
export function myBridge() {
  return mine
}

// Troca o IP público da minha ponte pelo IP da rede de casa nos candidatos
// "relay" que chegam dos outros. Assim o meu PC fala com a ponte por dentro de
// casa, sem depender do roteador aceitar "dar a volta" (hairpin).
export function fixRemoteSdp(sdp) {
  if (!mine || !sdp) return sdp
  const ip = mine.publicIp.replace(/\./g, '\\.')
  return sdp.replace(new RegExp(` ${ip} (\\d+) typ relay`, 'g'), ` ${mine.lanIp} $1 typ relay`)
}

// Testa se uma ponte responde de verdade (pede um endereço a ela) antes de usar.
// Uma ponte que não responde faria a ligação esperar até o navegador desistir dela.
async function bridgeWorks(entry, ms = 3000) {
  let pc
  try {
    pc = new RTCPeerConnection({ iceServers: [entry], iceTransportPolicy: 'relay' })
    pc.createDataChannel('teste')
    const ok = new Promise((resolve) => {
      pc.onicecandidate = (e) => {
        if (e.candidate && / typ relay/.test(e.candidate.candidate)) resolve(true)
      }
      setTimeout(() => resolve(false), ms)
    })
    await pc.setLocalDescription(await pc.createOffer())
    return await ok
  } catch {
    return false
  } finally {
    try { pc?.close() } catch {}
  }
}

// Uma sessão por sala.
export function startBridgeLink({ code, selfId, relays, onChange }) {
  const state = { closed: false, socks: [], timer: null, info: null, bridges: new Map(), topic: null, key: null, priv: null, pub: null }
  const added = [] // entradas que coloquei na lista de servidores ICE

  const ready = (async () => {
    state.topic = hex(await sha256(`telinha-ponte-${VERSION}:${code}`)).slice(0, 40)
    const raw = await sha256(`telinha-ponte-chave-${VERSION}:${code}`)
    state.key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    state.priv = schnorr.utils.randomPrivateKey()
    state.pub = hex(schnorr.getPublicKey(state.priv))
  })()

  async function seal(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, state.key, enc.encode(JSON.stringify(obj))))
    return `${b64(iv)}.${b64(ct)}`
  }

  async function open(text) {
    const [iv, ct] = String(text).split('.')
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, state.key, unb64(ct))
    return JSON.parse(dec.decode(pt))
  }

  async function makeEvent(content) {
    const ev = { pubkey: state.pub, created_at: Math.floor(Date.now() / 1000), kind: KIND, tags: [['x', state.topic]], content }
    const id = await sha256(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))
    ev.id = hex(id)
    ev.sig = hex(schnorr.sign(id, state.priv))
    return ev
  }

  async function onEvent(ev) {
    if (!ev || ev.pubkey === state.pub) return
    let msg
    try {
      msg = await open(ev.content)
    } catch {
      return
    }
    if (!msg || msg.id === selfId || !msg.ip || !msg.port) return
    if (Date.now() - (msg.t || 0) > 60_000) return
    const key = `${msg.ip}:${msg.port}`
    if (state.bridges.has(key)) return
    // Marca como "testando" para não testar a mesma ponte várias vezes.
    state.bridges.set(key, { ...msg, ok: null })
    const entry = { urls: `turn:${msg.ip}:${msg.port}?transport=udp`, username: msg.user, credential: msg.pass }
    const ok = await bridgeWorks(entry)
    if (state.closed) return
    state.bridges.set(key, { ...msg, ok })
    if (ok && added.length < MAX_BRIDGES) {
      ICE_SERVERS.push(entry) // a lista é usada a cada nova tentativa de ligação
      added.push(entry)
    }
    // Ponte que não respondeu: tenta de novo daqui a 1 minuto (pode ter sido liberada).
    if (!ok) setTimeout(() => state.bridges.get(key)?.ok === false && state.bridges.delete(key), 60_000)
    onChange?.()
  }

  function connect(url) {
    if (state.closed) return
    let ws
    try {
      ws = new WebSocket(url)
    } catch {
      return
    }
    state.socks.push(ws)
    ws.onopen = async () => {
      await ready
      const since = Math.floor(Date.now() / 1000) - 30
      ws.send(JSON.stringify(['REQ', `ponte-${state.topic.slice(0, 8)}`, { kinds: [KIND], '#x': [state.topic], since }]))
    }
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data)
        if (m[0] === 'EVENT') onEvent(m[2])
      } catch {}
    }
    ws.onclose = () => {
      state.socks = state.socks.filter((s) => s !== ws)
      if (!state.closed) setTimeout(() => connect(url), 5000)
    }
    ws.onerror = () => {}
  }

  async function announce() {
    if (state.closed || !state.info?.ok) return
    await ready
    const content = await seal({ id: selfId, ip: state.info.publicIp, port: state.info.port, user: state.info.user, pass: state.info.pass, t: Date.now() })
    const ev = await makeEvent(content)
    const text = JSON.stringify(['EVENT', ev])
    for (const ws of state.socks) if (ws.readyState === 1) ws.send(text)
  }

  relays.forEach(connect)

  return {
    // Liga o anúncio da minha ponte (quando o Rust conseguiu abrir).
    setMine(info) {
      state.info = info
      mine = info?.ok ? info : null
      clearInterval(state.timer)
      if (info?.ok) {
        announce()
        state.timer = setInterval(announce, ANNOUNCE_MS)
      }
      onChange?.()
    },
    // Quantas pontes de outras pessoas estão funcionando.
    others() {
      return [...state.bridges.values()].filter((b) => b.ok).length
    },
    close() {
      state.closed = true
      clearInterval(state.timer)
      for (const ws of state.socks) try { ws.close() } catch {}
      for (const e of added) {
        const i = ICE_SERVERS.indexOf(e)
        if (i >= 0) ICE_SERVERS.splice(i, 1)
      }
      mine = null
    },
  }
}
