import './styles.css'
import { icons, renderIcons, setIcon } from './icons.js'
import { createCode, normalizeCode, openRoom, relayStatus, RELAYS } from './room.js'
import { startBridgeLink } from './bridge.js'
import { openMic } from './mic.js'
import {
  isTauri, captureScreen, captureCamera, applyVideoQuality, preferH264, tuneSenders, videoKbps, Mixer, FPS,
  installBitrateBoost,
} from './media.js'
import { CAMERA_KBPS } from './config.js'
import { invoke } from '@tauri-apps/api/core'

const $ = (s) => document.querySelector(s)
renderIcons()
installBitrateBoost()

// ---------- utilidades ----------
function show(view) {
  for (const v of ['home', 'room']) $(`#view-${v}`).hidden = v !== view
}

let toastTimer
function toast(msg, ms = 3200) {
  const el = $('#toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), ms)
}

function showError(el, msg) {
  el.textContent = msg
  el.hidden = !msg
}

const errMsg = (e) => (typeof e === 'string' ? e : e?.message || String(e))
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const myName = () => $('#home-name').value.trim() || 'Alguém'

// Cores das pessoas na sala (claras, para ler bem no fundo escuro).
const PEOPLE_COLORS = [
  '#3ddc97', '#8fd3e8', '#c9b6f0', '#f2c48d', '#f0a3b5', '#f2e07a',
  '#9db8ff', '#ff9f80', '#a5e88a', '#e0a3f0', '#7fe0d0', '#ffd1a8',
]
function hashStr(str) {
  let h = 0
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
// Cada pessoa ganha uma cor diferente das outras da sala. A preferida vem do id
// dela (assim tende a ser a mesma em todos os PCs); se já estiver em uso, pega a próxima livre.
function colorOf(id) {
  if (!S) return PEOPLE_COLORS[0]
  if (S.colors.has(id)) return S.colors.get(id)
  const used = new Set([...S.colors.entries()].filter(([k]) => k === S.net.selfId || S.peers.has(k)).map(([, c]) => c))
  let i = hashStr(id) % PEOPLE_COLORS.length
  for (let n = 0; n < PEOPLE_COLORS.length && used.has(PEOPLE_COLORS[i]); n++) i = (i + 1) % PEOPLE_COLORS.length
  S.colors.set(id, PEOPLE_COLORS[i])
  return PEOPLE_COLORS[i]
}
function avatar(name, color) {
  return `<span class="avatar" style="background:${color}22;color:${color}">${esc(name[0]?.toUpperCase() || '?')}</span>`
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('telinha:prefs') || '{}')
    if (typeof p.pc === 'boolean') $('#opt-pc').checked = p.pc
    if (typeof p.mic === 'boolean') $('#opt-mic').checked = p.mic
    if (typeof p.cam === 'boolean') $('#opt-cam').checked = p.cam
    // Máximo de 1080p: preferências antigas (Nativa/1440p) voltam para 1080p.
    $('#opt-res').value = p.res === 720 ? '720' : '1080'
    $('#home-name').value = localStorage.getItem('telinha:name') || ''
  } catch {}
}
function savePrefs(p) {
  try { localStorage.setItem('telinha:prefs', JSON.stringify(p)) } catch {}
}
loadPrefs()
$('#home-name').addEventListener('change', () => {
  try { localStorage.setItem('telinha:name', $('#home-name').value.trim()) } catch {}
})

// ---------- início ----------
$('#btn-create').addEventListener('click', (e) => {
  e.stopPropagation() // senão o clique fecha a janelinha de compartilhar que abrimos
  showError($('#home-error'), '')
  enterRoom(createCode(), true)
})

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const code = normalizeCode($('#join-code').value)
  if (!code) {
    showError($('#home-error'), 'O código da sala tem 4 números, por exemplo 7342.')
    return
  }
  showError($('#home-error'), '')
  enterRoom(code, false)
})
$('#join-code').addEventListener('input', () => showError($('#home-error'), ''))

// =====================================================================
// SALA
// Todo mundo está conectado com todo mundo. Quem compartilha a tela envia
// para todos; quem assiste escolhe qual tela fica grande no palco.
// =====================================================================
let S = null // sessão atual

function enterRoom(code, openShare) {
  const net = openRoom(code)
  S = {
    code,
    net,
    peers: new Map(), // id -> { name, sharing, cam, screen, camStream, rtt }
    me: null, // minha transmissão: { out, video, cam, mixer, res }
    focus: null, // 'me' ou id de quem está no palco
    colors: new Map(), // id -> cor da pessoa
    timers: [],
    lastBytes: new Map(),
  }
  colorOf(net.selfId)
  $('#room-code').textContent = code
  setFullscreen(false)
  show('room')
  render()
  if (openShare) {
    $('#share-pop').hidden = false
    showError($('#share-error'), '')
  }

  attachNet(net)
  S.timers.push(setInterval(stats, 2000))
  S.enteredAt = Date.now()
  startBridge(code, net.selfId)

  // Rede de segurança: se ficar 90 s sozinho, entra de novo na sala.
  // Não pode ser rápido: entre internets diferentes a ligação dos PCs leva
  // vários segundos, e sair da sala no meio dela cancela a conexão.
  S.aloneSince = Date.now()
  S.timers.push(setInterval(() => {
    if (!S) return
    if (S.peers.size > 0) {
      S.aloneSince = Date.now()
      return
    }
    if (Date.now() - S.aloneSince < 90000) return
    try { S.net.room.leave() } catch {}
    S.net = openRoom(S.code)
    attachNet(S.net)
    S.aloneSince = Date.now()
  }, 2000))
}

// ---------- ponte automática ----------
// Cada Telinha tenta virar uma ponte (abre portas no roteador e roda um servidor
// TURN). Quem não consegue se ligar direto passa pela ponte de alguém da sala.
async function startBridge(code, selfId) {
  const link = startBridgeLink({ code, selfId, relays: RELAYS, onChange: () => S && render() })
  S.bridge = link
  if (!isTauri) return
  try {
    // Na primeira vez, o Windows pede permissão para liberar o Telinha no firewall.
    if (!localStorage.getItem('telinha:fw')) {
      const ok = await invoke('ensure_firewall').catch(() => false)
      try { localStorage.setItem('telinha:fw', ok ? '1' : '0') } catch {}
    }
    const info = await invoke('start_bridge')
    if (!S || S.bridge !== link) return
    S.bridgeInfo = info
    link.setMine(info)
  } catch {
    if (S?.bridge === link) S.bridgeInfo = { ok: false, reason: 'erro' }
  }
  if (S) render()
}

function bridgeText() {
  const b = S.bridgeInfo
  const others = S.bridge?.others?.() || 0
  if (b?.ok) return 'ponte ligada'
  if (others) return 'usando a ponte de um amigo'
  if (b?.reason === 'cgnat') return 'sua internet não permite ser ponte'
  if (b && !b.ok) return 'seu roteador não abriu a ponte'
  return ''
}

// Liga os eventos da sala (gente entrando/saindo, telas, chat, imagens).
function attachNet(net) {
  net.room.onPeerJoin((id) => {
    if (!S.peers.has(id)) S.peers.set(id, { name: 'Entrando…', sharing: false, cam: false, rtt: null })
    colorOf(id)
    net.sendState(myState(), id)
    if (S.me) sendMyStreamsTo(id)
    if (S.voice) net.room.addStream(S.voice, id, { kind: 'voice' })
    render()
  })

  net.room.onPeerLeave((id) => {
    dropVoice(S.peers.get(id))
    S.peers.delete(id)
    S.lastBytes.delete(id)
    if (S.focus === id) S.focus = null
    render()
  })

  net.onState((data, id) => {
    const p = S.peers.get(id) || { rtt: null }
    p.name = String(data?.name || 'Alguém').slice(0, 24)
    p.sharing = !!data?.sharing
    p.cam = !!data?.cam
    p.watching = data?.watching || null
    p.voice = !!data?.voice
    if (!p.sharing) {
      p.screen = null
      p.camStream = null
      if (S.focus === id) S.focus = null
    }
    if (!p.cam) p.camStream = null
    S.peers.set(id, p)
    render()
  })

  net.room.onPeerStream((stream, id, meta) => {
    const p = S.peers.get(id) || { name: 'Alguém', rtt: null }
    const kind = meta?.kind || (!stream.getVideoTracks().length ? 'voice' : stream.getAudioTracks().length ? 'screen' : 'camera')
    if (kind === 'voice') {
      playVoice(p, stream)
    } else if (kind === 'camera') {
      // Quem manda se a câmera aparece é o aviso "cam" da pessoa (onState).
      // Aqui só guardamos o vídeo, e escondemos se ele parar de chegar.
      p.camStream = stream
      for (const t of stream.getVideoTracks()) {
        t.addEventListener('mute', render)
        t.addEventListener('unmute', render)
        t.addEventListener('ended', render)
      }
      stream.addEventListener('removetrack', render)
    } else {
      p.screen = stream
      p.sharing = true
      if (!S.focus) S.focus = id
    }
    S.peers.set(id, p)
    render()
  })

  net.onImg((data, id, meta) => {
    const type = IMG_TYPES.includes(meta?.type) ? meta.type : null
    const bytes = data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data) ? data.buffer : null
    if (!type || !bytes || bytes.byteLength > MAX_IMG_BYTES) return
    addChat(S.peers.get(id)?.name || 'Alguém', '', false, new Blob([bytes], { type }), colorOf(id))
  })

  net.onTalk((on, id) => {
    const p = S.peers.get(id)
    if (!p) return
    p.talking = !!on
    p.talkAt = Date.now()
    markTalk(id, p.talking)
  })

  net.onChat((data, id) => {
    const text = String(data?.text || '').slice(0, 500).trim()
    if (text) addChat(S.peers.get(id)?.name || 'Alguém', text, false, null, colorOf(id))
  })

}

// `watching`: de quem é a tela que eu estou vendo grande. Quem compartilha usa
// isso para mandar qualidade total só para quem está assistindo a tela dele,
// e uma miniatura leve para o resto (economiza internet e PC de quem transmite).
function myState() {
  return { name: myName(), sharing: !!S?.me, cam: !!S?.me?.cam, voice: !!S?.voice || !!S?.me?.mixer?.micOn, watching: S?.focus && S.focus !== 'me' ? S.focus : null }
}

function broadcastState() {
  S?.net.sendState(myState())
}

// ---------- conversa por microfone (para todo mundo, transmitindo ou não) ----------
// Quem não está transmitindo manda só a voz. Quem está transmitindo usa o
// "Seu microfone" da live (que já vai junto com o som da tela).
function playVoice(p, stream) {
  dropVoice(p)
  const el = document.createElement('audio')
  el.autoplay = true
  el.srcObject = stream
  el.play().catch(() => {})
  document.body.appendChild(el)
  p.voiceEl = el
}

function dropVoice(p) {
  if (!p?.voiceEl) return
  p.voiceEl.srcObject = null
  p.voiceEl.remove()
  p.voiceEl = null
}

async function setVoice(on) {
  if (!S) return
  if (on && !S.voice) {
    let mic
    try {
      mic = await openMic({ onSpeaking: setTalking })
    } catch {
      toast('Não consegui abrir o microfone.')
      return
    }
    if (!S) return mic.stop()
    S.voiceMic = mic
    S.voice = mic.stream
    for (const id of Object.keys(S.net.room.getPeers())) S.net.room.addStream(S.voice, id, { kind: 'voice' })
  } else if (!on && S.voice) {
    try { S.net.room.removeStream(S.voice) } catch {}
    S.voiceMic?.stop()
    S.voiceMic = null
    S.voice = null
  }
  broadcastState()
  render()
}
$('#btn-voice').addEventListener('click', () => setVoice(!S?.voice))

// ---------- quem está falando (o nome acende, igual no Discord) ----------
function setTalking(on) {
  if (!S || S.talking === on) return
  S.talking = on
  clearInterval(S.talkTimer)
  try { S.net.sendTalk(on) } catch {}
  // Enquanto fala, repete o aviso (se um se perder, o nome não fica aceso para sempre).
  if (on) S.talkTimer = setInterval(() => { try { S?.net.sendTalk(true) } catch {} }, 2000)
  markTalk(S.net.selfId, on)
}

function markTalk(id, on) {
  const li = document.querySelector(`#people li[data-id="${CSS.escape(id)}"]`)
  li?.classList.toggle('talking', !!on)
}

function isTalking(id) {
  if (id === S.net.selfId) return !!S.talking
  const p = S.peers.get(id)
  return !!p?.talking && Date.now() - (p.talkAt || 0) < 3500
}

// A câmera só aparece se ainda estiver chegando imagem dela.
function camLive(stream) {
  return !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted)
}

function sendMyStreamsTo(id) {
  const { room } = S.net
  room.addStream(S.me.out, id, { kind: 'screen' })
  if (S.me.cam) room.addStream(S.me.cam, id, { kind: 'camera' })
  const pc = room.getPeers()[id]
  if (pc) preferH264(pc)
}

// ---------- palco e miniaturas ----------
function sharers() {
  const list = []
  if (S.me) list.push({ id: 'me', name: `${myName()} (você)`, screen: new MediaStream([S.me.video]), camStream: S.me.cam })
  for (const [id, p] of S.peers) {
    if (p.sharing && p.screen) list.push({ id, name: p.name, screen: p.screen, camStream: p.cam && camLive(p.camStream) ? p.camStream : null })
  }
  return list
}

let stageKey = null
const tileEls = new Map()

function render() {
  if (!S) return
  const list = sharers()
  if (S.focus && !list.find((x) => x.id === S.focus)) S.focus = null
  if (!S.focus && list.length) S.focus = list.find((x) => x.id !== 'me')?.id || list[0].id
  const cur = list.find((x) => x.id === S.focus)

  // Palco
  const video = $('#stage-video')
  if (!cur) {
    if (video.srcObject) video.srcObject = null
    stageKey = null
    $('#stage-empty').hidden = false
    $('#stage-tag').hidden = true
    $('#stage-cam').hidden = true
    $('#stage-play').hidden = true
    $('#btn-empty-share').hidden = !!S.me
  } else {
    $('#stage-empty').hidden = true
    const key = cur.id === 'me' ? `me:${S.me.video.id}` : `${cur.id}:${cur.screen.id}`
    if (stageKey !== key) {
      stageKey = key
      video.srcObject = cur.id === 'me' ? new MediaStream([S.me.video]) : cur.screen
      applyVolume()
      video.play().then(() => ($('#stage-play').hidden = true)).catch(() => ($('#stage-play').hidden = false))
    }
    $('#stage-tag').textContent = cur.id === 'me' ? 'Sua tela' : cur.name
    $('#stage-tag').hidden = false
    const cam = $('#stage-cam')
    if (cur.camStream) {
      if (cam.srcObject !== cur.camStream) cam.srcObject = cur.camStream
      const wasHidden = cam.hidden
      cam.hidden = false
      if (wasHidden) placePip()
    } else {
      cam.hidden = true
      cam.srcObject = null
    }
  }

  // Miniaturas das outras telas (clique para trocar o palco)
  const others = list.filter((x) => x.id !== S.focus)
  $('#tiles').hidden = others.length === 0
  for (const [id, el] of tileEls) {
    if (!others.find((x) => x.id === id)) {
      el.remove()
      tileEls.delete(id)
    }
  }
  for (const t of others) {
    let el = tileEls.get(t.id)
    if (!el) {
      el = document.createElement('button')
      el.className = 'tile'
      el.innerHTML = '<video autoplay muted playsinline></video><span class="tile-name"></span>'
      el.addEventListener('click', () => {
        S.focus = t.id
        render()
      })
      tileEls.set(t.id, el)
      $('#tiles').appendChild(el)
    }
    const v = el.querySelector('video')
    const src = t.id === 'me' ? S.me.video : t.screen
    const srcKey = src.id
    if (el.dataset.src !== srcKey) {
      el.dataset.src = srcKey
      v.srcObject = t.id === 'me' ? new MediaStream([S.me.video]) : t.screen
      v.play().catch(() => {})
    }
    el.querySelector('.tile-name').textContent = t.name
    el.setAttribute('aria-label', `Ver a tela de ${t.name}`)
  }

  // Pessoas na sala
  const people = $('#people')
  people.innerHTML = ''
  const addPerson = (id, name, live, rtt, talking) => {
    const li = document.createElement('li')
    li.dataset.id = id
    if (isTalking(id)) li.classList.add('talking')
    let q = ''
    if (rtt != null) {
      const ms = rtt * 1000
      q = ms < 90 ? '<span class="q good">ótima</span>' : ms < 220 ? '<span class="q mid">média</span>' : '<span class="q bad">fraca</span>'
    }
    li.innerHTML = `${avatar(name, colorOf(id))}<span class="name">${esc(name)}</span>${talking ? `<span class="mic-pill" title="Com o microfone ligado">${icons.mic}</span>` : ''}${live ? '<span class="live-pill">AO VIVO</span>' : ''}${q}`
    people.appendChild(li)
  }
  addPerson(S.net.selfId, `${myName()} (você)`, !!S.me, null, !!S.voice || !!S.me?.mixer?.micOn)
  for (const [id, p] of S.peers) addPerson(id, p.name, p.sharing, p.rtt, p.voice)
  const total = S.peers.size + 1
  $('#people-count').textContent = total
  $('#people-empty').hidden = S.peers.size > 0
  const live = list.length
  if (S.peers.size === 0) {
    // Sozinho na sala: mostra se está conseguindo falar com os servidores de encontro.
    const rs = S.relay
    const bt = bridgeText()
    $('#room-sub').textContent = !rs
      ? 'Procurando amigos…'
      : rs.open > 0
        ? `Procurando amigos… · ${rs.open} de ${rs.total} servidores de encontro${bt ? ` · ${bt}` : ''}`
        : 'Sem acesso aos servidores de encontro (antivírus ou firewall bloqueando?)'
  } else {
    $('#room-sub').textContent = `${total} ${total === 1 ? 'pessoa' : 'pessoas'}${live ? ` · ${live} ${live === 1 ? 'tela ao vivo' : 'telas ao vivo'}` : ''}`
  }

  // Avisa os outros quando eu troco a tela que estou assistindo
  if (S.sentFocus !== S.focus) {
    S.sentFocus = S.focus
    broadcastState()
  }

  // Meus controles
  $('#share-wrap').hidden = !!S.me
  $('#btn-voice').hidden = !!S.me
  $('#btn-voice').classList.toggle('on', !!S.voice)
  setIcon($('#btn-voice [data-icon]'), S.voice ? 'mic' : 'micOff')
  $('#share-ctrls').hidden = !S.me
  $('#my-stats').hidden = !S.me
  if (S.me) {
    const m = S.me.mixer
    $('#btn-pc').classList.toggle('on', m.pcOn)
    setIcon($('#btn-pc [data-icon]'), m.pcOn ? 'volume' : 'volumeOff')
    $('#btn-mic').classList.toggle('on', m.micOn)
    setIcon($('#btn-mic [data-icon]'), m.micOn ? 'mic' : 'micOff')
    $('#btn-cam').classList.toggle('on', !!S.me.cam)
    setIcon($('#btn-cam [data-icon]'), S.me.cam ? 'cam' : 'camOff')
    const parts = []
    if (m.pcOn) parts.push('PC')
    if (m.micOn) parts.push('microfone')
    $('#st-audio').textContent = parts.length ? parts.join(' + ') : 'desligado'
  }
}

// Só o som da tela que está no palco toca (e nunca o da sua própria tela).
function applyVolume() {
  const v = $('#stage-video')
  const vol = Number($('#vol').value) / 100
  v.volume = vol
  v.muted = S?.focus === 'me' || vol === 0 || $('#btn-mute').dataset.muted === '1'
}

$('#btn-play').addEventListener('click', () => {
  $('#stage-video').play().then(() => ($('#stage-play').hidden = true)).catch(() => {})
})

$('#vol').addEventListener('input', () => {
  $('#btn-mute').dataset.muted = '0'
  applyVolume()
  setIcon($('#btn-mute [data-icon]'), Number($('#vol').value) === 0 ? 'volumeOff' : 'volume')
})
$('#btn-mute').addEventListener('click', () => {
  const b = $('#btn-mute')
  b.dataset.muted = b.dataset.muted === '1' ? '0' : '1'
  applyVolume()
  setIcon($('#btn-mute [data-icon]'), b.dataset.muted === '1' ? 'volumeOff' : 'volume')
})

// ---------- câmera arrastável ----------
// Quem assiste pode arrastar a câmera para qualquer canto do palco (só na tela
// dele). A posição fica guardada como fração do espaço livre, então se mantém
// quando a janela muda de tamanho ou entra em tela cheia.
const PIP_MARGIN = 16
let pipPos = { x: 1, y: 1 } // 1,1 = canto inferior direito
try {
  const saved = JSON.parse(localStorage.getItem('telinha:pip') || 'null')
  if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') pipPos = saved
} catch {}

function placePip() {
  const stage = $('#stage')
  const pip = $('#stage-cam')
  if (pip.hidden) return
  const freeW = Math.max(0, stage.clientWidth - pip.offsetWidth - PIP_MARGIN * 2)
  const freeH = Math.max(0, stage.clientHeight - pip.offsetHeight - PIP_MARGIN * 2)
  pip.style.left = `${PIP_MARGIN + pipPos.x * freeW}px`
  pip.style.top = `${PIP_MARGIN + pipPos.y * freeH}px`
}

;(() => {
  const pip = $('#stage-cam')
  let drag = null
  pip.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    pip.setPointerCapture(e.pointerId)
    drag = { dx: e.clientX - pip.offsetLeft, dy: e.clientY - pip.offsetTop }
    pip.classList.add('dragging')
  })
  pip.addEventListener('pointermove', (e) => {
    if (!drag) return
    const stage = $('#stage')
    const freeW = Math.max(1, stage.clientWidth - pip.offsetWidth - PIP_MARGIN * 2)
    const freeH = Math.max(1, stage.clientHeight - pip.offsetHeight - PIP_MARGIN * 2)
    const left = Math.min(Math.max(e.clientX - drag.dx, PIP_MARGIN), PIP_MARGIN + freeW)
    const top = Math.min(Math.max(e.clientY - drag.dy, PIP_MARGIN), PIP_MARGIN + freeH)
    pipPos = { x: (left - PIP_MARGIN) / freeW, y: (top - PIP_MARGIN) / freeH }
    pip.style.left = `${left}px`
    pip.style.top = `${top}px`
  })
  const end = () => {
    if (!drag) return
    drag = null
    pip.classList.remove('dragging')
    try { localStorage.setItem('telinha:pip', JSON.stringify(pipPos)) } catch {}
  }
  pip.addEventListener('pointerup', end)
  pip.addEventListener('pointercancel', end)
  pip.addEventListener('loadedmetadata', placePip)
  new ResizeObserver(placePip).observe($('#stage'))
})()

// ---------- tela cheia ----------
// Usa a tela cheia do próprio palco (igual a player de vídeo). A tela cheia da
// janela do Tauri no Windows deixa a imagem bugada enquanto o WebView2 se redesenha.
async function setFullscreen(on) {
  try {
    if (on && !document.fullscreenElement) await $('#stage').requestFullscreen()
    else if (!on && document.fullscreenElement) await document.exitFullscreen()
  } catch (e) {
    console.warn('tela cheia', e)
  }
}
const isFs = () => !!document.fullscreenElement
document.addEventListener('fullscreenchange', () => {
  setIcon($('#btn-fs [data-icon]'), isFs() ? 'shrink' : 'expand')
})
$('#btn-fs').addEventListener('click', () => setFullscreen(!isFs()))
$('#btn-exit-fs').addEventListener('click', () => setFullscreen(false))
$('#stage-video').addEventListener('dblclick', () => setFullscreen(!isFs()))

// ---------- compartilhar minha tela ----------
function togglePop(e) {
  e.stopPropagation()
  $('#share-pop').hidden = !$('#share-pop').hidden
  showError($('#share-error'), '')
}
$('#btn-share').addEventListener('click', togglePop)
$('#btn-empty-share').addEventListener('click', togglePop)
$('#share-pop').addEventListener('click', (e) => e.stopPropagation())
document.addEventListener('click', () => ($('#share-pop').hidden = true))

$('#btn-pick').addEventListener('click', startShare)

async function startShare() {
  const opts = {
    res: Number($('#opt-res').value),
    pc: $('#opt-pc').checked,
    mic: $('#opt-mic').checked || !!S?.voice,
    cam: $('#opt-cam').checked,
  }
  savePrefs(opts)
  showError($('#share-error'), '')

  // O seletor do Windows precisa abrir logo após o clique.
  let screen
  try {
    screen = await captureScreen({ res: opts.res, withAudio: !isTauri && opts.pc })
  } catch (e) {
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') {
      showError($('#share-error'), `Não consegui capturar a tela: ${errMsg(e)}`)
    }
    return
  }
  if (!S) {
    screen.getTracks().forEach((t) => t.stop())
    return
  }
  $('#btn-pick').disabled = true
  try {
    const mixer = new Mixer()
    await mixer.start()
    if (!isTauri) {
      const a = screen.getAudioTracks()[0]
      if (a) {
        screen.removeTrack(a)
        mixer.addBrowserAudio(a)
      }
    } else if (opts.pc) {
      try {
        await mixer.setPcAudio(true)
      } catch (e) {
        toast(`Áudio do PC indisponível: ${errMsg(e)}`, 5000)
      }
    }
    if (opts.mic) {
      try {
        await mixer.setMic(true)
      } catch {
        toast('Não consegui abrir o microfone.')
      }
    }

    const video = screen.getVideoTracks()[0]
    video.contentHint = 'detail'
    video.addEventListener('ended', onScreenEnded)
    S.me = { out: new MediaStream([video, mixer.track]), video, cam: null, mixer, res: opts.res }
    mixer.onSpeaking = setTalking
    if (S.voice) await setVoice(false)
    $('#q-res').value = String(opts.res)
    $('#share-pop').hidden = true

    if (opts.cam) await setCamera(true)
    for (const id of Object.keys(S.net.room.getPeers())) sendMyStreamsTo(id)
    broadcastState()
    if (!S.focus || ![...S.peers.values()].some((p) => p.sharing)) S.focus = 'me'
    render()
  } catch (e) {
    screen.getTracks().forEach((t) => t.stop())
    showError($('#share-error'), `Algo deu errado: ${errMsg(e)}`)
  } finally {
    $('#btn-pick').disabled = false
  }
}

function onScreenEnded() {
  toast('O compartilhamento de tela foi encerrado.')
  stopShare()
}

async function stopShare(leaving = false) {
  if (!S?.me) return
  const me = S.me
  S.me = null
  try { S.net.room.removeStream(me.out) } catch {}
  if (me.cam) {
    try { S.net.room.removeStream(me.cam) } catch {}
    me.cam.getTracks().forEach((t) => t.stop())
  }
  me.video.removeEventListener('ended', onScreenEnded)
  const wasTalking = me.mixer.micOn
  me.out.getTracks().forEach((t) => t.stop())
  await me.mixer.stop()
  if (wasTalking && !leaving) await setVoice(true)
  if (S.focus === 'me') S.focus = null
  broadcastState()
  render()
}
$('#btn-stop').addEventListener('click', () => stopShare())

async function setCamera(on) {
  if (!S?.me) return
  if (on) {
    let cam
    try {
      cam = await captureCamera()
    } catch {
      toast('Não consegui abrir a câmera.')
      return
    }
    S.me.cam = cam
    for (const id of Object.keys(S.net.room.getPeers())) S.net.room.addStream(cam, id, { kind: 'camera' })
  } else if (S.me.cam) {
    try { S.net.room.removeStream(S.me.cam) } catch {}
    S.me.cam.getTracks().forEach((t) => t.stop())
    S.me.cam = null
  }
  broadcastState()
  render()
}
$('#btn-cam').addEventListener('click', () => setCamera(!S?.me?.cam))

$('#btn-pc').addEventListener('click', async () => {
  try {
    await S.me.mixer.setPcAudio(!S.me.mixer.pcOn)
  } catch (e) {
    toast(`Áudio do PC indisponível: ${errMsg(e)}`, 5000)
  }
  render()
})

$('#btn-mic').addEventListener('click', async () => {
  try {
    await S.me.mixer.setMic(!S.me.mixer.micOn)
  } catch {
    toast('Não consegui abrir o microfone.')
  }
  broadcastState()
  render()
})

$('#btn-switch').addEventListener('click', async () => {
  let next
  try {
    next = await captureScreen({ res: S.me.res, withAudio: false })
  } catch {
    return
  }
  if (!S?.me) {
    next.getTracks().forEach((t) => t.stop())
    return
  }
  const old = S.me.video
  const track = next.getVideoTracks()[0]
  track.contentHint = 'detail'
  for (const pc of Object.values(S.net.room.getPeers())) {
    for (const s of pc.getSenders()) if (s.track === old) s.replaceTrack(track).catch(() => {})
  }
  S.me.out.removeTrack(old)
  S.me.out.addTrack(track)
  S.me.video = track
  old.removeEventListener('ended', onScreenEnded)
  old.stop()
  track.addEventListener('ended', onScreenEnded)
  render()
  toast('Tela trocada.')
})

$('#q-res').addEventListener('change', async () => {
  S.me.res = Number($('#q-res').value)
  await applyVideoQuality(S.me.video, S.me.res)
  for (const [id, pc] of Object.entries(S.net.room.getPeers())) tuneSenders(pc, (t) => videoPlan(t, id))
})

function videoPlan(track, peerId) {
  if (!S?.me) return null
  if (track === S.me.video) {
    const p = peerId ? S.peers.get(peerId) : null
    // Quem não está vendo minha tela grande recebe só uma miniatura leve.
    if (p && p.watching !== S.net.selfId) return { kbps: 350, fps: 15, scale: 4 }
    return { kbps: videoKbps(S.me.res, S.me.video), fps: FPS }
  }
  if (S.me.cam && track === S.me.cam.getVideoTracks()[0]) return { kbps: CAMERA_KBPS, fps: FPS }
  return null
}

// ---------- estatísticas (a cada 2 s) ----------
// Mostra para quem assiste se o som está chegando e com quanto atraso
// (tempo de viagem + espera do áudio no buffer).
function soundInfo(id, a, rtt) {
  const p = S.peers.get(id)
  if (!a || !p) return 'sem som'
  const prev = p.audioBytes || 0
  p.audioBytes = a.bytesReceived || 0
  if (p.audioBytes <= prev) return 'sem som'
  const buf = a.jitterBufferEmittedCount ? (a.jitterBufferDelay / a.jitterBufferEmittedCount) * 1000 : 0
  const ms = Math.round(buf + ((rtt || 0) * 1000) / 2)
  const quiet = (a.audioLevel ?? 1) < 0.001
  return quiet ? `som ok (silêncio) · ${ms} ms` : `som ok · ${ms} ms`
}

async function stats() {
  if (!S) return
  for (const [id, p] of S.peers) if (p.talking && !isTalking(id)) { p.talking = false; markTalk(id, false) }
  try { S.relay = relayStatus() } catch {}
  const peers = S.net.room.getPeers()
  let upBits = 0
  let watchInfo = ''
  for (const [id, pc] of Object.entries(peers)) {
    if (S.me) tuneSenders(pc, (t) => videoPlan(t, id))
    try {
      const report = await pc.getStats()
      let bytes = 0
      let rtt = null
      let inbound = null
      let audioIn = null
      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') audioIn = r
        if (r.type === 'outbound-rtp' && r.kind === 'video') bytes += r.bytesSent || 0
        if (r.type === 'inbound-rtp' && r.kind === 'video' && (!inbound || (r.frameHeight || 0) > (inbound.frameHeight || 0))) inbound = r
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime
      })
      const prev = S.lastBytes.get(id)
      if (prev != null && bytes >= prev) upBits += ((bytes - prev) * 8) / 2
      S.lastBytes.set(id, bytes)
      const p = S.peers.get(id)
      if (p && rtt != null) p.rtt = rtt
      if (id === S.focus && inbound?.frameHeight) {
        watchInfo = `${inbound.frameHeight}p · ${Math.round(inbound.framesPerSecond || 0)} fps`
        watchInfo += ' · ' + soundInfo(id, audioIn, rtt)
      }
    } catch {}
  }
  if (S.me) {
    $('#st-up').textContent = `${(upBits / 1e6).toFixed(1).replace('.', ',')} Mbps`
    const s = S.me.video.getSettings()
    $('#st-quality').textContent = s.height ? `${s.height}p · ${Math.round(s.frameRate || FPS)} fps` : '–'
  }
  $('#info').textContent = S.focus === 'me' ? 'Você está no palco' : watchInfo
  render()
}

// ---------- chat da sala ----------
const URL_RE = /(https?:\/\/[^\s<>"]+)/g

function openLink(url) {
  if (!/^https?:\/\//i.test(url)) return
  if (isTauri) invoke('open_url', { url }).catch(() => toast('Não consegui abrir o link.'))
  else window.open(url, '_blank', 'noopener')
}

function addChat(name, text, mine, image, color) {
  const log = $('#chat-log')
  $('#chat-empty').hidden = true
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60
  const msg = document.createElement('div')
  msg.className = mine ? 'msg mine' : 'msg'
  msg.style.setProperty('--c', color || PEOPLE_COLORS[0])
  const who = document.createElement('span')
  who.className = 'msg-name'
  who.textContent = mine ? 'Você' : name
  const time = document.createElement('span')
  time.className = 'msg-time'
  time.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const head = document.createElement('div')
  head.className = 'msg-head'
  head.append(who, time)
  const body = document.createElement('div')
  body.className = 'msg-body'
  if (image) {
    const url = URL.createObjectURL(image)
    const img = document.createElement('img')
    img.className = 'msg-img'
    img.alt = `Imagem enviada por ${mine ? 'você' : name}`
    img.src = url
    img.title = 'Clique para ver grande'
    img.addEventListener('load', () => {
      if (mine || nearBottom) log.scrollTop = log.scrollHeight
    })
    img.addEventListener('click', () => openLightbox(url))
    msg.dataset.url = url
    body.append(img)
  }
  // Monta o texto com nós de texto (nunca HTML), transformando só links em <a>.
  for (const part of (text || '').split(URL_RE)) {
    if (!part) continue
    if (/^https?:\/\//i.test(part)) {
      const a = document.createElement('a')
      a.href = part
      a.textContent = part
      a.title = 'Abrir no navegador'
      a.addEventListener('click', (e) => {
        e.preventDefault()
        openLink(part)
      })
      body.append(a)
    } else {
      body.append(document.createTextNode(part))
    }
  }
  msg.append(head, body)
  log.append(msg)
  while (log.querySelectorAll('.msg').length > 200) removeMsg(log.querySelector('.msg'))
  if (mine || nearBottom) log.scrollTop = log.scrollHeight
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = $('#chat-input')
  const text = input.value.trim().slice(0, 500)
  if (!text || !S) return
  S.net.sendChat({ text })
  addChat(myName(), text, true, null, colorOf(S.net.selfId))
  input.value = ''
})

function removeMsg(m) {
  if (m.dataset.url) URL.revokeObjectURL(m.dataset.url)
  m.remove()
}

// ---------- imagens no chat ----------
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMG_BYTES = 8 * 1024 * 1024
const MAX_IMG_SIDE = 1920

// Reduz a imagem (lado maior até 1920 px, WebP) para chegar rápido em todo mundo.
// GIF vai como está, para continuar animado.
async function prepareImage(file) {
  if (file.type === 'image/gif') {
    if (file.size > MAX_IMG_BYTES) throw new Error('GIF muito grande (máximo 8 MB).')
    return { bytes: await file.arrayBuffer(), type: 'image/gif' }
  }
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMG_SIDE / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
  bmp.close?.()
  let blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.86))
  if (!blob || blob.type !== 'image/webp') blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86))
  if (!blob) throw new Error('Não consegui ler a imagem.')
  if (blob.size > MAX_IMG_BYTES) throw new Error('Imagem muito grande.')
  return { bytes: await blob.arrayBuffer(), type: blob.type }
}

async function sendImageFile(file) {
  if (!S || !file || !file.type.startsWith('image/')) return
  try {
    const { bytes, type } = await prepareImage(file)
    S.net.sendImg(bytes, null, { type })
    addChat(myName(), '', true, new Blob([bytes], { type }), colorOf(S.net.selfId))
  } catch (e) {
    toast(errMsg(e))
  }
}

function imageFromClipboard(e) {
  for (const item of e.clipboardData?.items || []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile()
  }
  return null
}

// Ctrl+V com imagem em qualquer lugar da sala envia no chat.
document.addEventListener('paste', (e) => {
  if (!S || $('#view-room').hidden) return
  const file = imageFromClipboard(e)
  if (!file) return
  e.preventDefault()
  sendImageFile(file)
})

$('#chat-attach').addEventListener('click', () => $('#chat-file').click())
$('#chat-file').addEventListener('change', () => {
  for (const f of $('#chat-file').files) sendImageFile(f)
  $('#chat-file').value = ''
})

const chatCard = document.querySelector('.chat')
chatCard.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) {
    e.preventDefault()
    chatCard.classList.add('drop')
  }
})
chatCard.addEventListener('dragleave', () => chatCard.classList.remove('drop'))
chatCard.addEventListener('drop', (e) => {
  e.preventDefault()
  chatCard.classList.remove('drop')
  for (const f of e.dataTransfer?.files || []) sendImageFile(f)
})

function openLightbox(url) {
  $('#lightbox-img').src = url
  $('#lightbox').hidden = false
}
$('#lightbox').addEventListener('click', () => ($('#lightbox').hidden = true))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#lightbox').hidden = true
})

function clearChat() {
  $('#chat-log').querySelectorAll('.msg').forEach(removeMsg)
  $('#lightbox').hidden = true
  $('#chat-empty').hidden = false
  $('#chat-input').value = ''
}

// ---------- copiar código e sair ----------
$('#btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(S.code)
    toast('Código copiado. Mande para os amigos!')
  } catch {
    toast(`Código: ${S.code}`)
  }
})

async function leaveRoom() {
  if (!S) return
  await stopShare(true)
  S.voiceMic?.stop()
  if (S.voice) S.voice.getTracks().forEach((t) => t.stop())
  clearInterval(S.talkTimer)
  for (const p of S.peers.values()) dropVoice(p)
  S.bridge?.close()
  if (isTauri) invoke('stop_bridge').catch(() => {})
  const s = S
  S = null
  s.timers.forEach(clearInterval)
  try { s.net.room.leave() } catch {}
  $('#stage-video').srcObject = null
  $('#stage-cam').srcObject = null
  for (const [, el] of tileEls) el.remove()
  tileEls.clear()
  stageKey = null
  clearChat()
  $('#share-pop').hidden = true
  if (isFs()) setFullscreen(false)
  show('home')
}
$('#btn-leave').addEventListener('click', leaveRoom)

// Sai da sala ao fechar o app, para os outros saberem na hora.
window.addEventListener('beforeunload', () => {
  try { S?.net.room.leave() } catch {}
})
