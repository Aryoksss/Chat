// ============================================================
// WhatsApp Bot — Entry Point
// ============================================================

import { WhatsAppClient } from './core/client.js'
import { validateConfig } from './system/config.js'
import { logger } from './system/logger.js'
import { personaLoader } from './persona/loader.js'
import { messageHandler } from './message/handler.js'

async function main() {
  console.log(`
╔══════════════════════════════════════╗
║     🤖 WhatsApp AI Bot v1.0         ║
║     Multi-Persona + 9router AI      ║
╚══════════════════════════════════════╝
  `)

  // 1. Validate config
  const errors = validateConfig()
  if (errors.length > 0) {
    logger.error({ errors }, 'Config validation failed')
    console.error('❌ Config errors:')
    errors.forEach(e => console.error(`   - ${e}`))
    console.error('\n📝 Edit .env file and restart.')
    process.exit(1)
  }
  logger.info('✅ Config validated')

  // 2. Load personas
  logger.info('Loading personas...')
  const personas = await personaLoader.loadAll()
  if (personas.size === 0) {
    logger.warn('No personas loaded — bot will not respond to messages')
  } else {
    logger.info({ count: personas.size }, 'Personas loaded')
  }

  // 3. Inject personas into message handler
  messageHandler.setPersonas(personas)

  // 4. Start WhatsApp client
  const client = new WhatsAppClient()

  // 5. Wire up message handler
  client.onMessage(async (msg) => {
    await messageHandler.handle(msg, client)
  })

  // 6. Connect
  await client.start()

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
