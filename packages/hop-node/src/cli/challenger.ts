import { actionHandler, parseBool, root } from './shared'

import {
  startChallengeWatchers
} from 'src/watchers/watchers'

root
  .command('challenger')
  .description('Start the challenger watcher')
  .option(
    '--dry [boolean]',
    'Start in dry mode. If enabled, no transactions will be sent.',
    parseBool
  )
  .action(actionHandler(main))

async function main (source: any) {
  const { dry: dryMode } = source
  await startChallengeWatchers({
    dryMode
  })
}
