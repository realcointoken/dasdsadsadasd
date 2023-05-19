import ArbitrumBridgeWatcher from 'src/watchers/ArbitrumBridgeWatcher'
import BaseZkBridgeWatcher from 'src/watchers/BaseZkBridgeWatcher'
import GnosisBridgeWatcher from 'src/watchers/GnosisBridgeWatcher'
import OptimismBridgeWatcher from 'src/watchers/OptimismBridgeWatcher'
import PolygonBridgeWatcher from 'src/watchers/PolygonBridgeWatcher'
import chainSlugToId from 'src/utils/chainSlugToId'
import { ConfirmRootsData } from 'src/watchers/ConfirmRootsWatcher'
import { actionHandler, parseBool, parseString, parseStringArray, root } from './shared'
import { getConfirmRootsWatcher } from 'src/watchers/watchers'

// Nova and Arbitrum One both use the same Arbitrum Bridge Watcher
type ExitWatcher = GnosisBridgeWatcher | PolygonBridgeWatcher | OptimismBridgeWatcher | BaseZkBridgeWatcher | ArbitrumBridgeWatcher

root
  .command('confirm-root')
  .description('Confirm a root with an exit from the canonical bridge or with the messenger wrapper')
  .option('--chain <slug>', 'Chain', parseString)
  .option('--token <symbol>', 'Token', parseString)
  .option('--root-hashes <hash, ...>', 'Comma-separated root hashes with CommitTransfers event log', parseStringArray)
  .option('--wrapper-confirmation [boolean]', 'Confirm a root via the messenger wrapper', parseBool)
  .option(
    '--dry [boolean]',
    'Start in dry mode. If enabled, no transactions will be sent.',
    parseBool
  )
  .action(actionHandler(main))

async function main (source: any) {
  const {
    chain,
    token,
    rootHashes,
    wrapperConfirmation,
    dry: dryMode
  } = source

  if (!chain) {
    throw new Error('chain is required')
  }
  if (!token) {
    throw new Error('token is required')
  }
  if (!rootHashes?.length) {
    throw new Error('root hashes required')
  }

  const watcher = await getConfirmRootsWatcher({ chain, token, dryMode })
  if (!watcher) {
    throw new Error('watcher not found')
  }

  const dbTransferRoots: any[] = []
  for (const rootHash of rootHashes) {
    const dbTransferRoot: any = await watcher.db.transferRoots.getByTransferRootHash(rootHash)
    if (!dbTransferRoot) {
      throw new Error('TransferRoot does not exist in the DB')
    }
    dbTransferRoots.push(dbTransferRoot)
  }

  // Verify that the intended source chain is being used
  for (const dbTransferRoot of dbTransferRoots) {
    if (dbTransferRoot.sourceChainId !== chainSlugToId(chain)) {
      throw new Error('TransferRoot source chain does not match passed in chain')
    }

    if (dbTransferRoot.sourceChainId !== watcher.bridge.chainSlugToId(chain)) {
      throw new Error('TransferRoot source chain does not match watcher source chain')
    }
  }

  if (wrapperConfirmation) {
    const rootDatas: ConfirmRootsData = {
      rootHashes: [],
      destinationChainIds: [],
      totalAmounts: [],
      rootCommittedAts: []
    }
    for (const dbTransferRoot of dbTransferRoots) {
      const { transferRootHash, destinationChainId, totalAmount, committedAt } = dbTransferRoot
      if (
        !transferRootHash ||
        !destinationChainId ||
        !totalAmount ||
        !committedAt
      ) {
        throw new Error('TransferRoot is missing required data')
      }

      if (destinationChainId === chainSlugToId(chain)) {
        throw new Error('Cannot confirm a root with a destination chain of the same chain')
      }

      rootDatas.rootHashes.push(transferRootHash)
      rootDatas.destinationChainIds.push(destinationChainId)
      rootDatas.totalAmounts.push(totalAmount)
      rootDatas.rootCommittedAts.push(committedAt)
    }

    console.log('rootDatas', rootDatas)
    await watcher.confirmRootsViaWrapper(rootDatas)
  } else {
    const chainSpecificWatcher: ExitWatcher = watcher.watchers[chain]
    for (const dbTransferRoot of dbTransferRoots) {
      const commitTxHash = dbTransferRoot.commitTxHash
      if (!commitTxHash) {
        throw new Error('commitTxHash is required')
      }
      console.log('commitTxHash', commitTxHash)
      await chainSpecificWatcher.relayXDomainMessage(commitTxHash)
    }
  }
  console.log('done')
}
