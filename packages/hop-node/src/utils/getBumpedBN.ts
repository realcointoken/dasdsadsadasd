import { BigNumber } from 'ethers'
import { parseUnits } from 'ethers/lib/utils'

const getBumpedBN = (value: BigNumber, multiplier: number = 1) => {
  return value.mul(parseUnits(multiplier.toString(), 100)).div(parseUnits('1', 100))
}

export default getBumpedBN
