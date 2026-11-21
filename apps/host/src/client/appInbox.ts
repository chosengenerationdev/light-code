/**
 * Messages for the chat app that arrive before it is listening.
 *
 * In Fire Code this page says it is ready as soon as the script runs - to get its appearance early - but the app
 * mounts only once the page has its session, which for a new chat is after its agent has started. "Start a chat"
 * from a monitoring alert sends the alert's text in that gap, so it reached nobody and the chat opened with an
 * empty box (reported twice; the first fix, in Fire Code 0.75.0, corrected the message's shape and not this).
 * Held here, and handed over once the app has subscribed.
 */
export interface InboxTransport {
  listenerCount(): number
  redeliver(message: unknown): void
}

export class AppInbox {
  private readonly held: unknown[] = []
  private listening = false

  constructor(
    private readonly transport: InboxTransport,
    private readonly wait: (then: () => void) => void = (then) => setTimeout(then, 50),
  ) {}

  deliver(message: unknown): void {
    if (this.listening) this.transport.redeliver(message)
    else this.held.push(message)
  }

  /** Call just before the app renders: hands over what was held once one more listener has subscribed. */
  openWhenListening(deadline = Date.now() + 60_000): void {
    const baseline = this.transport.listenerCount()
    const check = (): void => {
      if (this.transport.listenerCount() > baseline) {
        this.listening = true
        for (const message of this.held.splice(0)) this.transport.redeliver(message)
        return
      }
      // A page that never mounts has bigger problems; stop asking after a minute.
      if (Date.now() < deadline) this.wait(check)
    }
    this.wait(check)
  }
}
