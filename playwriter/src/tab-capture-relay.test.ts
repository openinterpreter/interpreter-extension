import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createServer } from 'node:net'
import { startPlayWriterCDPRelayServer, type RelayServer } from './cdp-relay.js'

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

let relay: RelayServer | null = null
let socket: WebSocket | null = null
afterEach(() => {
  socket?.close()
  relay?.close()
  socket = null
  relay = null
})

it('accepts only extension-origin tab offers and relays answer and stop', async () => {
  const port = await unusedPort()
  relay = await startPlayWriterCDPRelayServer({ port, host: '127.0.0.1' })
  socket = new WebSocket(`ws://127.0.0.1:${port}/extension?browser=Chrome&installId=test`, {
    origin: 'chrome-extension://pebbngnfojnignonigcnkdilknapkgid',
  })
  await new Promise<void>((resolve, reject) => {
    socket!.once('open', resolve)
    socket!.once('error', reject)
  })
  socket.send(JSON.stringify({ method: 'tabCaptureOffer', params: {
    captureId: 'capture_test_12345678', tabId: 42, title: 'Test tab', offerSdp: 'v=0\r\nmock-local-offer-1234567890',
  } }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(relay.listTabCaptures()).toMatchObject([{
    captureId: 'capture_test_12345678', tabId: 42, title: 'Test tab',
  }])
  const answer = new Promise<Record<string, unknown>>((resolve) => socket!.once('message', (data) => resolve(JSON.parse(String(data)))))
  expect(relay.answerTabCapture('capture_test_12345678', 'v=0\r\nmock-local-answer-1234567890')).toBe(true)
  expect(await answer).toMatchObject({ method: 'tabCaptureAnswer', params: { captureId: 'capture_test_12345678' } })
  const stop = new Promise<Record<string, unknown>>((resolve) => socket!.once('message', (data) => resolve(JSON.parse(String(data)))))
  expect(relay.stopTabCapture('capture_test_12345678')).toBe(true)
  expect(await stop).toMatchObject({ method: 'tabCaptureStop', params: { captureId: 'capture_test_12345678' } })
  expect(relay.listTabCaptures()).toEqual([])
})
