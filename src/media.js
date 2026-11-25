// Captura de tela, câmera, microfone e mixagem de áudio.
import { invoke, Channel } from '@tauri-apps/api/core'
import { VIDEO_KBPS, MAX_KBPS } from './config.js'
import { fixRemoteSdp } from './bridge.js'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const SIZES = { 720: [1280, 720], 1080: [1920, 1080] }

// Toda transmissão é a 30 fps, priorizando nitidez.
export const FPS = 30

// res = 0 significa "resolução nativa": a taxa sai do tamanho real da tela.
export function videoKbps(res, track) {
  if (VIDEO_KBPS[res]) return VIDEO_KBPS[res]
  const st = track?.getSettings?.() || {}
  const px = (st.width || 1920) * (st.height || 1080)
  return Math.min(MAX_KBPS, Math.max(VIDEO_KBPS[720], Math.round((px * FPS * 0.11) / 1000)))
}

function videoConstraints(res, fps = FPS) {
  // Limite da transmissão: 1080p (qualquer outro valor vira 1080p).
  const [w, h] = SIZES[res] || SIZES[1080]
  // "ideal" pede os quadros escolhidos de verdade (sem ele o Windows captura a 30 fps).
  return { width: { max: w }, height: { max: h }, frameRate: { ideal: fps, max: fps } }
}

// Abre o seletor do sistema ("Escolha o que compartilhar").
// Precisa ser chamada direto a partir de um clique do usuário.
export async function captureScreen({ res, withAudio }) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: videoConstraints(res),
    audio: withAudio,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    systemAudio: withAudio ? 'include' : 'exclude',
  })
  // No app, esconde a barra "... está compartilhando sua tela" do WebView2.
  if (isTauri) invoke('hide_share_bar').catch(() => {})
  return stream
}

export async function applyVideoQuality(track, res) {
  track.contentHint = 'detail'
  try {
    await track.applyConstraints(videoConstraints(res))
  } catch (e) {
    console.warn('applyConstraints falhou', e)
  }
}

export async function captureCamera() {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { max: 30 } },
    audio: false,
  })
}

// Coloca H.264 na frente: no Windows ele costuma ser codificado pela placa de
// vídeo, o que deixa a transmissão bem mais leve para o processador.
export function preferH264(pc) {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video')
    if (!caps) return
    const h264 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264')
    if (!h264.length) return
    const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264')
    for (const t of pc.getTransceivers()) {
      if (t.sender?.track?.kind === 'video' && t.setCodecPreferences) {
        t.setCodecPreferences([...h264, ...rest])
      }
    }
  } catch (e) {
    console.warn('Não deu para preferir H.264', e)
  }
}

// Ajusta bitrate máximo e prioridade (sempre nitidez) de cada envio de vídeo.
// `plan(track)` devolve { kbps, fps, scale? } ou null.
export function tuneSenders(pc, plan) {
  for (const s of pc.getSenders()) {
    if (!s.track || s.track.kind !== 'video') continue
    const want = plan(s.track)
    if (!want) continue
    const p = s.getParameters()
    if (!p.encodings || !p.encodings.length) continue
    const enc = p.encodings[0]
    const bitrate = want.kbps * 1000
    // Nunca reduzir a resolução escolhida: se a conexão apertar, cai um pouco o fps.
    const pref = 'maintain-resolution'
    if (
      enc.maxBitrate === bitrate &&
      enc.maxFramerate === want.fps &&
      enc.scaleResolutionDownBy === (want.scale || 1) &&
      p.degradationPreference === pref
    ) continue
    enc.maxBitrate = bitrate
    enc.maxFramerate = want.fps
    enc.scaleResolutionDownBy = want.scale || 1
    enc.priority = 'high'
    enc.networkPriority = 'high'
    p.degradationPreference = pref
    s.setParameters(p).catch(() => {})
  }
}

// Junta áudio do PC + microfone numa única faixa de áudio. Assim ligar/desligar
// um deles nunca precisa renegociar a conexão com os amigos.
export class Mixer {
  async start() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    await this.ctx.resume()
    this.dest = this.ctx.createMediaStreamDestination()
    this.pcGain = this.ctx.createGain()
    this.micGain = this.ctx.createGain()
    this.pcGain.connect(this.dest)
    this.micGain.connect(this.dest)
    this.pcOn = false
    this.micOn = false
  }

  get track() {
    return this.dest.stream.getAudioTracks()[0]
  }

  // Fora do Tauri (testando no navegador), o áudio do PC vem do próprio seletor.
  addBrowserAudio(track) {
    this.browserSrc = this.ctx.createMediaStreamSource(new MediaStream([track]))
    this.browserSrc.connect(this.pcGain)
    this.browserTrack = track
    this.pcOn = true
  }

  async setPcAudio(on) {
    if (!isTauri) {
      this.pcGain.gain.value = on ? 1 : 0
      this.pcOn = on && !!this.browserTrack
      return this.pcOn
    }
    if (!on) {
      await invoke('stop_system_audio').catch(() => {})
      this.pcOn = false
      return false
    }
    if (!this.node) {
      await this.ctx.audioWorklet.addModule('/pcm-player.js')
      this.node = new AudioWorkletNode(this.ctx, 'pcm-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      this.node.connect(this.pcGain)
    }
    const ch = new Channel()
    ch.onmessage = (arr) => {
      const pcm = Int16Array.from(arr)
      this.node.port.postMessage(pcm, [pcm.buffer])
    }
    const info = await invoke('start_system_audio', { onChunk: ch })
    this.node.port.postMessage({ inputRate: info.sampleRate })
    this.pcOn = true
    return true
  }

  async setMic(on) {
    if (on) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      this.micSrc = this.ctx.createMediaStreamSource(this.micStream)
      this.micSrc.connect(this.micGain)
      this.micOn = true
    } else {
      this.micSrc?.disconnect()
      this.micStream?.getTracks().forEach((t) => t.stop())
      this.micSrc = null
      this.micStream = null
      this.micOn = false
    }
    return this.micOn
  }

  async stop() {
    if (isTauri) await invoke('stop_system_audio').catch(() => {})
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.browserTrack?.stop()
    await this.ctx?.close().catch(() => {})
  }
}

// Faz o WebRTC já começar com uma taxa boa e não despencar para quase nada.
// Sem isso ele começa em ~0,3 Mbps e demora para subir (imagem borrada no começo).
// Funciona ajustando as linhas "fmtp" de vídeo da negociação (SDP).
const START_KBPS = 2500
const MIN_KBPS = 600

function mungeSdp(sdp) {
  if (!sdp) return sdp
  const parts = sdp.split(/\r\n(?=m=)/)
  return parts
    .map((sec) => {
      if (sec.startsWith('m=audio')) return mungeOpus(sec)
      if (!sec.startsWith('m=video')) return sec
      const pts = sec.split('\r\n')[0].split(' ').slice(3)
      let lines = sec.split('\r\n')
      for (const pt of pts) {
        const rtpmap = lines.find((l) => l.startsWith(`a=rtpmap:${pt} `))
        if (!rtpmap || /rtx|red|ulpfec|flexfec/i.test(rtpmap)) continue
        const extra = `x-google-start-bitrate=${START_KBPS};x-google-min-bitrate=${MIN_KBPS}`
        const i = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `))
        if (i >= 0) {
          if (!lines[i].includes('x-google-start-bitrate')) lines[i] += `;${extra}`
        } else {
          const r = lines.indexOf(rtpmap)
          lines.splice(r + 1, 0, `a=fmtp:${pt} ${extra}`)
        }
      }
      return lines.join('\r\n')
    })
    .join('\r\n')
}

// Som do PC em estéreo e com qualidade de música (128 kbps), em vez do
// padrão de voz (mono, ~32 kbps). Também sem pausas em silêncio (usedtx=0).
function mungeOpus(sec) {
  const lines = sec.split('\r\n')
  const rtpmap = lines.find((l) => /^a=rtpmap:\d+ opus\//i.test(l))
  if (!rtpmap) return sec
  const pt = rtpmap.split(':')[1].split(' ')[0]
  const want = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '128000', useinbandfec: '1', usedtx: '0' }
  const i = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `))
  const params = new Map()
  if (i >= 0) {
    for (const kv of lines[i].slice(`a=fmtp:${pt} `.length).split(';')) {
      const [k, v] = kv.split('=')
      if (k) params.set(k.trim(), v)
    }
  }
  for (const [k, v] of Object.entries(want)) params.set(k, v)
  const line = `a=fmtp:${pt} ` + [...params].map(([k, v]) => (v == null ? k : `${k}=${v}`)).join(';')
  if (i >= 0) lines[i] = line
  else lines.splice(lines.indexOf(rtpmap) + 1, 0, line)
  return lines.join('\r\n')
}

export function installBitrateBoost() {
  const P = RTCPeerConnection.prototype
  if (P.__telinhaBoost) return
  P.__telinhaBoost = true
  const origLocal = P.setLocalDescription
  const origRemote = P.setRemoteDescription
  P.setLocalDescription = async function (desc) {
    try {
      if (desc && desc.type === 'rollback') return origLocal.call(this, desc)
      if (!desc || !desc.sdp) {
        const answering = this.signalingState === 'have-remote-offer' || this.signalingState === 'have-local-pranswer'
        desc = answering ? await this.createAnswer() : await this.createOffer()
      }
      return origLocal.call(this, { type: desc.type, sdp: mungeSdp(desc.sdp) })
    } catch (e) {
      // Se algo der errado, segue o caminho normal (sem o ajuste).
      return origLocal.apply(this, arguments)
    }
  }
  P.setRemoteDescription = function (desc) {
    if (desc && desc.sdp) desc = { type: desc.type, sdp: fixRemoteSdp(mungeSdp(desc.sdp)) }
    return origRemote.call(this, desc)
  }
}
