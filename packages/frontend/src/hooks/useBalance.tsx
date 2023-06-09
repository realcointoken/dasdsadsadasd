import { useQuery } from 'react-query'
import { ChainId, Token } from '@hop-protocol/sdk'
import { Addressish } from 'src/models/Address'
import { StakingRewards } from '@hop-protocol/core/contracts'
import { Contract } from 'ethers'

type ContractType = Token | StakingRewards | Token | Contract

async function fetchBalance(token: ContractType, address: string) {
  return await token.balanceOf(address)
}

const useBalance = (token?: ContractType, address?: Addressish, chainId?: ChainId) => {
  chainId = token instanceof Token ? token.chain.chainId : chainId

  const queryKey = `balance:${chainId}:${token?.address}:${address?.toString()}`

  const { isLoading, isError, data, error } = useQuery(
    [queryKey, chainId, token?.address, address?.toString()],
    async () => {
      if (token && address) {
        return await fetchBalance(token, address.toString())
      }
    },
    {
      enabled: !!chainId && !!token?.address && !!address?.toString(),
      refetchInterval: 10e3,
    }
  )

  return { loading: isLoading, isError, balance: data, error }
}

export default useBalance
