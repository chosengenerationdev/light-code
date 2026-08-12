import { App } from '@light-code/ui'
import { createRoot } from 'react-dom/client'
import { HttpTransport } from './transport.js'

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Light Code: no #root element to mount into.')

const status = document.getElementById('status')
const setStatus = (text: string): void => {
  if (status === null) return
  // Hidden once connected: a permanent banner reading "connected" is noise, and the only
  // state worth interrupting for is the one where nothing is going to work.
  status.textContent = text === 'connected' ? '' : text
  status.style.display = text === 'connected' ? 'none' : 'block'
}

const transport = new HttpTransport(setStatus)

transport
  .connect()
  .then(() => createRoot(rootElement).render(<App transport={transport} />))
  .catch((error: unknown) => {
    setStatus(error instanceof Error ? error.message : String(error))
  })
