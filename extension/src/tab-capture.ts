type Capture = { stream: MediaStream; peer: RTCPeerConnection; audio: AudioContext | null }
const captures = new Map<string, Capture>()

function stop(captureId: string): void {
  const capture = captures.get(captureId)
  if (!capture) return
  captures.delete(captureId)
  capture.stream.getTracks().forEach((track) => track.stop())
  capture.peer.close()
  void capture.audio?.close()
  void chrome.runtime.sendMessage({ type: 'interpreter-tab-capture-stopped', captureId }).catch(() => {})
}

async function waitForIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, 5_000)
    function done() {
      clearTimeout(timeout)
      peer.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    function check() { if (peer.iceGatheringState === 'complete') done() }
    peer.addEventListener('icegatheringstatechange', check)
  })
}

async function start(message: { captureId: string; streamId: string; tabId: number; title: string }): Promise<void> {
  for (const id of captures.keys()) stop(id)
  const mandatory = { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory }, video: { mandatory },
  } as unknown as MediaStreamConstraints)
  const peer = new RTCPeerConnection({ iceServers: [] })
  const audio = stream.getAudioTracks().length ? new AudioContext() : null
  if (audio) audio.createMediaStreamSource(stream).connect(audio.destination)
  captures.set(message.captureId, { stream, peer, audio })
  for (const track of stream.getTracks()) {
    peer.addTrack(track, stream)
    track.addEventListener('ended', () => stop(message.captureId), { once: true })
  }
  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState === 'failed' || peer.connectionState === 'closed') stop(message.captureId)
  })
  await peer.setLocalDescription(await peer.createOffer())
  await waitForIce(peer)
  const offerSdp = peer.localDescription?.sdp
  if (!offerSdp) throw new Error('Chrome could not create a tab-capture offer.')
  await chrome.runtime.sendMessage({
    type: 'interpreter-tab-capture-offer',
    captureId: message.captureId,
    tabId: message.tabId,
    title: message.title,
    offerSdp,
  })
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object') return
  const value = message as Record<string, unknown>
  if (value.type === 'interpreter-tab-capture-start') {
    void start(value as { captureId: string; streamId: string; tabId: number; title: string }).catch((error) => {
      if (typeof value.captureId === 'string') stop(value.captureId)
      console.warn('Interpreter tab capture could not start:', error)
    })
  } else if (value.type === 'interpreter-tab-capture-answer'
    && typeof value.captureId === 'string' && typeof value.answerSdp === 'string') {
    const capture = captures.get(value.captureId)
    if (capture) void capture.peer.setRemoteDescription({ type: 'answer', sdp: value.answerSdp })
      .catch(() => stop(value.captureId as string))
  } else if (value.type === 'interpreter-tab-capture-stop' && typeof value.captureId === 'string') {
    stop(value.captureId)
  }
})
