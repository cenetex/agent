import { NextRequest, NextResponse } from 'next/server'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]'

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
})

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)

  if (!session?.user) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  const repo = request.nextUrl.searchParams.get('repo')

  if (!repo || !repo.includes('/')) {
    return NextResponse.json(
      { error: 'Invalid repo format. Expected: owner/repo' },
      { status: 400 }
    )
  }

  try {
    const bucket = process.env.ARTIFACTS_BUCKET || 'github-agent-artifacts'
    const key = `credits/${repo}/balance.json`

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })

    const response = await s3Client.send(command)
    const data = await response.Body?.transformToString()

    if (!data) {
      return NextResponse.json(
        { error: 'Balance data not found' },
        { status: 404 }
      )
    }

    return NextResponse.json(JSON.parse(data))
  } catch (error) {
    console.error('Failed to fetch balance:', error)
    return NextResponse.json(
      { error: 'Failed to fetch balance' },
      { status: 500 }
    )
  }
}
