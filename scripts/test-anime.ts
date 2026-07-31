import { handleAnimeSearch } from '../src/tools/handlers/anime'

;(async () => {
  try {
    const res = await handleAnimeSearch({ query: 'naruto' })
    console.log(JSON.stringify(res, null, 2))
  } catch (err) {
    console.error('Error running test:', err)
    process.exit(1)
  }
})()
