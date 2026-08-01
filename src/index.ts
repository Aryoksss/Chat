// ============================================================
// WhatsApp Bot — Entry Point
// ============================================================

import { WhatsAppClient } from './core/client.js'
import { validateConfigOrExit } from './system/config.js'
import { logger } from './system/logger.js'
import { personaLoader } from './persona/loader.js'
import { messageHandler } from './message/handler.js'
import { registerAllTools } from './tools/register-tools.js'

async function main() {
  console.log(`
╔══════════════════════════════════════╗
║     🤖 WhatsApp AI Bot v1.0         ║
║     Multi-Persona + 9router AI      ║
╚══════════════════════════════════════╝
  `)

  // 1. Validate config (explicit call, no side effects)
  validateConfigOrExit()
  logger.info('✅ Config validated')

  // 1.5 Register tools
  registerAllTools()

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
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('Shutting down...')
    await messageHandler.shutdown()
    await client.stop()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
