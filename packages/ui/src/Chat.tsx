import type { ReactElement } from 'react'
import { Composer } from './Composer.js'
import { MessageList, type DisplayMessage } from './MessageList.js'

export interface ChatProps {
  messages: DisplayMessage[]
  isStreaming: boolean
  error: string | undefined
  onSend: (text: string) => void
  onCancel: () => void
}

export function Chat(props: ChatProps): ReactElement {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <MessageList messages={props.messages} error={props.error} />
      </div>
      <Composer isStreaming={props.isStreaming} onSend={props.onSend} onCancel={props.onCancel} />
    </div>
  )
}
