// The experiment. Identical code runs in both the plain and MSIX builds; the
// container is the only variable.
//
// Two independent signals are recorded, because a CI runner may have no audio
// endpoint at all:
//   1. trackObtained — did the container even PERMIT the loopback capture API.
//      This is the MSIX question and it is answerable with no audio hardware.
//   2. peakRms / toneDetected — did real audio actually flow. Only meaningful
//      when a render endpoint exists; we play our own 440 Hz tone so that if
//      loopback works there is guaranteed to be something to capture.
const SAMPLE_MS = 5000
const TONE_HZ = 440

function fail(stage, err, extra) {
  window.probe.report({
    ok: false,
    stage,
    error: (err && (err.name + ': ' + err.message)) || String(err),
    ...(extra || {})
  })
}

async function run() {
  const notes = {}

  // --- Inventory the machine's audio devices (diagnostic context) -----------
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    notes.audioOutputCount = devices.filter((d) => d.kind === 'audiooutput').length
    notes.audioInputCount = devices.filter((d) => d.kind === 'audioinput').length
    notes.deviceKinds = devices.map((d) => d.kind + ':' + (d.label || '(no label)'))
  } catch (e) {
    notes.enumerateError = String(e && e.message)
  }

  // --- Play a tone so loopback has real signal to capture -------------------
  let ctx
  try {
    ctx = new AudioContext()
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    notes.audioContextState = ctx.state
    notes.sampleRate = ctx.sampleRate
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.frequency.value = TONE_HZ
    g.gain.value = 0.35
    osc.connect(g)
    g.connect(ctx.destination)
    osc.start()
    notes.tonePlaying = true
  } catch (e) {
    notes.tonePlaying = false
    notes.toneError = String(e && e.message)
  }

  // --- THE TEST: exactly Lamponi's win32 sequence ---------------------------
  let stream
  try {
    await window.probe.loopback.enable()
  } catch (e) {
    return fail('loopback.enable', e, notes)
  }

  try {
    // getDisplayMedia rejects without video — request it, then drop it, which
    // is what Lamponi does.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  } catch (e) {
    await window.probe.loopback.disable().catch(() => {})
    return fail('getDisplayMedia', e, notes)
  }

  try {
    stream.getVideoTracks().forEach((t) => t.stop())
    const audioTracks = stream.getAudioTracks()
    notes.audioTrackCount = audioTracks.length

    if (audioTracks.length === 0) {
      await window.probe.loopback.disable().catch(() => {})
      return fail('no-audio-track', new Error('loopback stream has no audio track'), notes)
    }

    const t = audioTracks[0]
    notes.trackLabel = t.label
    notes.trackReadyState = t.readyState
    notes.trackMuted = t.muted
    try {
      notes.trackSettings = t.getSettings()
    } catch (_) {}

    // --- Measure whether audio actually flows ------------------------------
    const analyserCtx = new AudioContext()
    const src = analyserCtx.createMediaStreamSource(new MediaStream([t]))
    const analyser = analyserCtx.createAnalyser()
    analyser.fftSize = 2048
    src.connect(analyser) // deliberately NOT connected to destination (no feedback)

    const time = new Float32Array(analyser.fftSize)
    const freq = new Float32Array(analyser.frequencyBinCount)
    const binHz = analyserCtx.sampleRate / analyser.fftSize
    const toneBin = Math.round(TONE_HZ / binHz)

    let peakRms = 0
    let bestToneDb = -Infinity
    const started = Date.now()

    await new Promise((resolve) => {
      const tick = () => {
        analyser.getFloatTimeDomainData(time)
        let sum = 0
        for (let i = 0; i < time.length; i++) sum += time[i] * time[i]
        const rms = Math.sqrt(sum / time.length)
        if (rms > peakRms) peakRms = rms

        analyser.getFloatFrequencyData(freq)
        for (let b = Math.max(0, toneBin - 2); b <= toneBin + 2; b++) {
          if (freq[b] > bestToneDb) bestToneDb = freq[b]
        }

        if (Date.now() - started >= SAMPLE_MS) resolve()
        else setTimeout(tick, 100)
      }
      tick()
    })

    notes.peakRms = Number(peakRms.toFixed(6))
    notes.toneBinDb = Number.isFinite(bestToneDb) ? Number(bestToneDb.toFixed(2)) : null
    // -100 dB is the analyser floor; anything clearly above it at 440 Hz means
    // our own tone came back through the loopback capture.
    notes.toneDetected = Number.isFinite(bestToneDb) && bestToneDb > -80
    notes.signalDetected = peakRms > 0.0005

    await window.probe.loopback.disable().catch(() => {})

    window.probe.report({
      ok: true,
      stage: 'complete',
      trackObtained: true,
      ...notes
    })
  } catch (e) {
    await window.probe.loopback.disable().catch(() => {})
    fail('analysis', e, notes)
  }
}

run().catch((e) => fail('unhandled', e))
