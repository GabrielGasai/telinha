// Microfone com cancelamento de ruído.
//
// Três camadas, todas no próprio PC:
//   1. a redução de ruído e o cancelamento de eco do navegador (tiram o grosso
//      do ventilador, do chiado e do som que sai das caixas);
//   2. filtros que cortam o que não é voz: o ronco grave (abaixo de 100 Hz) e o
//      chiado agudo (acima de 8 kHz);
//   3. um portão de ruído: o microfone fica mudo enquanto a pessoa não fala.
// O portão também diz quando a pessoa está falando (o nome dela acende na lista).

// Sensibilidade guardada no PC: { auto: true/false, value: 0..100 }.
// value maior = mais sensível (pega sons mais baixos).
const KEY = 'telinha:sens'
let sens = { auto: true, value: 50 }
try { sens = { ...sens, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch {}
const gates = new Set()
const levelFns = new Set()

// 0..100 -> limite em amplitude (de -10 dB até -70 dB).
export function valueToThreshold(v) {
  const db = -10 - (Math.min(100, Math.max(0, v)) / 100) * 60
  return Math.pow(10, db / 20)
}
// amplitude -> 0..100 na mesma escala (para desenhar a barrinha).
export function levelToValue(a) {
  const db = 20 * Math.log10(Math.max(a, 1e-6))
  return Math.min(100, Math.max(0, ((-10 - db) / 60) * 100))
}

export function getSensitivity() {
  return { ...sens }
}

export function setSensitivity(next) {
  sens = { ...sens, ...next }
  try { localStorage.setItem(KEY, JSON.stringify(sens)) } catch {}
  for (const g of gates) g.port.postMessage({ auto: sens.auto, threshold: valueToThreshold(sens.value) })
}

// Recebe o nível do microfone aberto (para a barrinha). Devolve a função para parar.
export function onMicLevel(fn) {
  levelFns.add(fn)
  return () => levelFns.delete(fn)
}

export function micIsOpen() {
  return gates.size > 0
}

export async function openMic({ onSpeaking } = {}) {
  const want = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  // Alguns Windows/Chrome têm isolamento de voz melhor; usa se existir.
  const sup = navigator.mediaDevices.getSupportedConstraints?.() || {}
  if (sup.voiceIsolation) want.voiceIsolation = true
  const raw = await navigator.mediaDevices.getUserMedia({ audio: want, video: false })

  const ctx = new AudioContext({ latencyHint: 'interactive' })
  await ctx.resume().catch(() => {})
  const src = ctx.createMediaStreamSource(raw)
  const low = ctx.createBiquadFilter()
  low.type = 'highpass'
  low.frequency.value = 100
  low.Q.value = 0.7
  const high = ctx.createBiquadFilter()
  high.type = 'lowpass'
  high.frequency.value = 8000
  high.Q.value = 0.7
  const dest = ctx.createMediaStreamDestination()
  src.connect(low).connect(high)

  let gate = null
  try {
    await ctx.audioWorklet.addModule('/noise-gate.js')
    gate = new AudioWorkletNode(ctx, 'noise-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    gate.port.onmessage = (e) => {
      const d = e.data || {}
      if (d.t === 'talk') onSpeaking?.(!!d.v)
      else if (d.t === 'lvl') for (const fn of levelFns) fn(d.v, d.thr)
    }
    gate.port.postMessage({ auto: sens.auto, threshold: valueToThreshold(sens.value) })
    gates.add(gate)
    high.connect(gate).connect(dest)
  } catch {
    // Sem o portão, segue só com os filtros.
    high.connect(dest)
  }

  return {
    stream: dest.stream,
    track: dest.stream.getAudioTracks()[0],
    stop() {
      if (gate) {
        gate.port.onmessage = null
        gates.delete(gate)
      }
      raw.getTracks().forEach((t) => t.stop())
      dest.stream.getTracks().forEach((t) => t.stop())
      ctx.close().catch(() => {})
      onSpeaking?.(false)
    },
  }
}
