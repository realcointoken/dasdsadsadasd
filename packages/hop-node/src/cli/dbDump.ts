import MerkleTree from 'src/utils/MerkleTree'
import chainSlugToId from 'src/utils/chainSlugToId'
import { GasCostTransactionType } from 'src/constants'
import { actionHandler, logger, parseInputFileList, parseNumber, parseString, root } from './shared'
import { getDbSet } from 'src/db'
import {
  config as globalConfig,
  setDbPath
} from 'src/config'

root
  .command('db-dump')
  .description('Dump leveldb database')
  .option(
    '--db <name>',
    'Name of db. Options are "transfers", "transfer-roots", "sync-state", "token-prices", "gas-cost"',
    parseString
  )
  .option('--db-path <path>', 'Path to leveldb.', parseString)
  .option('--token <symbol>', 'Token symbol', parseString)
  .option('--chain <slug>', 'Chain', parseString)
  .option('--nearest <timestamp>', 'Nearest timestamp in seconds', parseNumber)
  .option('--from-date <timestamp>', 'From date timestamp in seconds', parseNumber)
  .option('--to-date <timestamp>', 'To date timestamp in seconds', parseNumber)
  .option('--input-file <filepath>', 'Filepath containing list of ids', parseInputFileList)
  .option('--transfer-root-hash <transferRootHash>', 'Transfer root hash', parseString)
  .option('--transfer-root-id <transferRootId>', 'Transfer root hash', parseString)
  .action(actionHandler(main))

async function main (source: any) {
  let { dbPath, db: dbName, chain, token: tokenSymbol, nearest, fromDate, toDate, inputFile: inputFileList, transferRootId, transferRootHash } = source
  if (dbPath) {
    setDbPath(dbPath)
  }
  if (!tokenSymbol) {
    throw new Error('token is required')
  }
  const db = getDbSet(tokenSymbol)
  let items: any[] = []
  if (dbName === 'transfer-roots') {
    if (transferRootId || transferRootHash) {
      let dbTransferRoot
      if (transferRootHash) {
        dbTransferRoot = await db.transferRoots.getByTransferRootHash(
          transferRootHash
        )
      } else if (transferRootId) {
        dbTransferRoot = await db.transferRoots.getByTransferRootId(
          transferRootId
        )
      }
      if (!dbTransferRoot) {
        throw new Error('db item not found')
      }
      transferRootHash = dbTransferRoot.transferRootHash
      transferRootId = dbTransferRoot.transferRootId
      const transferIds = dbTransferRoot.transferIds
      if (!Array.isArray(transferIds)) {
        console.log(dbTransferRoot)
        throw new Error('transferIds expected to be array')
      }

      const tree = new MerkleTree(transferIds)
      const calculatedTransferRootHash = tree.getHexRoot()
      if (calculatedTransferRootHash !== transferRootHash) {
        logger.debug('transferIds:', JSON.stringify(transferIds))
        throw new Error(
          `transfers computed transfer root hash doesn't match. Expected ${transferRootHash}, got ${calculatedTransferRootHash}`
        )
      }
      console.log(dbTransferRoot)
      return
    }

    if (inputFileList) {
      const output: any[] = []
      for (const transferRootId of inputFileList) {
        const item = await db.transferRoots.getByTransferRootId(transferRootId)
        output.push(item || { transferRootId })
      }
      const filtered = output.map((x: any) => {
        const { transferRootId, transferRootHash, totalAmount, bonded, comitted, committedAt, confirmed, rootSetTimestamp, allSettled } = x
        return {
          transferRootId,
          transferRootHash,
          totalAmount,
          bonded,
          comitted,
          committedAt,
          confirmed,
          rootSetTimestamp,
          allSettled
        }
      })
      items = filtered
    } else {
      items = await db.transferRoots.getTransferRoots({
        fromUnix: fromDate,
        toUnix: toDate
      })
    }
  } else if (dbName === 'unbonded-roots') {
    items = await db.transferRoots.getUnbondedTransferRoots({
      sourceChainId: chainSlugToId(chain)
    })
  } else if (dbName === 'transfers') {
    if (inputFileList) {
      const output: any[] = []
      for (const transferId of inputFileList) {
        const item = await db.transfers.getByTransferId(transferId)
        output.push(item || { transferId })
      }
      const filtered = output.map((x: any) => {
        const { transferId, amount, transferSentTimestamp, withdrawalBonded, isBondable, withdrawalBondTxError, bondWithdrawalAttemptedAt } = x
        return {
          transferId,
          amount,
          withdrawalBonded,
          isBondable,
          transferSentTimestamp,
          withdrawalBondTxError,
          bondWithdrawalAttemptedAt
        }
      })
      items = filtered
    } else {
      items = await db.transfers.getTransfers({
        fromUnix: fromDate,
        toUnix: toDate
      })
    }
  } else if (dbName === 'sync-state') {
    items = await db.syncState.getItems()
  } else if (dbName === 'gas-cost') {
    if (tokenSymbol && nearest) {
      if (!chain) {
        throw new Error('chain flag is required')
      }
      items = await Promise.all([
        db.gasCost.getNearest(chain, tokenSymbol, GasCostTransactionType.BondWithdrawal, nearest),
        db.gasCost.getNearest(chain, tokenSymbol, GasCostTransactionType.BondWithdrawalAndAttemptSwap, nearest),
        db.gasCost.getNearest(chain, tokenSymbol, GasCostTransactionType.Relay, nearest)
      ])
    } else {
      items = await db.gasCost.getItems()
    }
  } else {
    throw new Error(`the db "${dbName}" does not exist. Options are: transfers, transfer-roots, sync-state, gas-prices, token-prices`)
  }

  logger.debug(`dumping ${dbName} db located at ${globalConfig.db.path}`)
  console.log(JSON.stringify(items, null, 2))
  logger.debug(`count: ${items.length}`)
}
