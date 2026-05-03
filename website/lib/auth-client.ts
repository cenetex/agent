import { useSession } from 'next-auth/react'

export function useAuthSession() {
  return useSession()
}
