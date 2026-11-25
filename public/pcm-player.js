// AudioWorklet que toca o áudio do PC recebido do Rust (estéreo, Int16 intercalado).
// Mantém um buffer pequeno (~40 ms) e descarta atraso acumulado acima de ~100 ms,
// para o som não ficar atrasado em relação à imagem.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.size = sampleRate * 2
    this.L = new Float32Array(this.size)
    this.R = new Float32Array(this.size)
    this.w = 0
    this.r = 0
    this.count = 0
    this.started = false
    this.target = Math.round(sampleRate * 0.04)
    this.max = Math.round(sampleRate * 0.1)
    this.ratio = 1 // taxa de entrada / taxa do AudioContext
    this.phase = 0
    this.lastL = 0
    this.lastR = 0
    this.port.onmessage = (e) => {
      if (e.data && e.data.inputRate) {
        this.ratio = e.data.inputRate / sampleRate
        this.phase = 0
      } else {
        this.push(e.data)
      }
    }
  }

  write(l, r) {
    this.L[this.w] = l
    this.R[this.w] = r
    this.w = (this.w + 1) % this.size
    this.count++
  }

  push(pcm) {
    const n = pcm.length >> 1
    if (n === 0) return
    if (this.ratio === 1) {
      for (let i = 0; i < n; i++) this.write(pcm[2 * i] / 32768, pcm[2 * i + 1] / 32768)
    } else {
      // Reamostragem linear. Índice 0 = última amostra do pedaço anterior.
      const at = (k, c) => (k === 0 ? (c === 0 ? this.lastL : this.lastR) : pcm[2 * (k - 1) + c] / 32768)
      while (this.phase < n) {
        const i = Math.floor(this.phase)
        const f = this.phase - i
        this.write(at(i, 0) * (1 - f) + at(i + 1, 0) * f, at(i, 1) * (1 - f) + at(i + 1, 1) * f)
        this.phase += this.ratio
      }
      this.phase -= n
      this.lastL = pcm[2 * (n - 1)] / 32768
      this.lastR = pcm[2 * (n - 1) + 1] / 32768
    }
    if (this.count > this.max) {
      const drop = this.count - this.target
      this.r = (this.r + drop) % this.size
      this.count = this.target
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const l = out[0]
    const r = out[1] || out[0]
    if (!this.started) {
      if (this.count >= this.target) this.started = true
      else {
        l.fill(0)
        r.fill(0)
        return true
      }
    }
    for (let i = 0; i < l.length; i++) {
      if (this.count > 0) {
        l[i] = this.L[this.r]
        r[i] = this.R[this.r]
        this.r = (this.r + 1) % this.size
        this.count--
      } else {
        l[i] = 0
        r[i] = 0
      }
    }
    if (this.count === 0) this.started = false
    return true
  }
}

registerProcessor('pcm-player', PcmPlayer)
