import { auth } from '@/auth'

export const getServerSession = async () => {
  return await auth()
}
