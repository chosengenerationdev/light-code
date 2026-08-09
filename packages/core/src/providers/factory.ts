import type { Logger } from '../logging/logger.js'
import type { HttpClient } from '../platform/http.js'
import { AnthropicProvider } from './anthropic.js'
import { GeminiProvider } from './gemini.js'
import { OpenAIProvider } from './openai.js'
import type { AuthStrategy, ChatProvider, ProviderProfile } from './types.js'

/**
 * Picks the wire adapter for a profile.
 *
 * Wire format and auth are separate axes (§10), which is what makes this a one-line switch:
 * every adapter takes the same `AuthStrategy`, so mutual TLS composes with Anthropic exactly
 * as it does with OpenAI, without either knowing about the other.
 */
export function createChatProvider(
  profile: ProviderProfile,
  http: HttpClient,
  auth: AuthStrategy,
  logger?: Logger,
): ChatProvider {
  switch (profile.wireFormat) {
    case 'anthropic':
      return new AnthropicProvider(http, profile, auth, logger)
    case 'gemini':
      return new GeminiProvider(http, profile, auth, logger)
    case 'openai':
      return new OpenAIProvider(http, profile, auth, logger)
  }
}
