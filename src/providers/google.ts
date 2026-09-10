import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { invariant } from '../core/util'

type Host = <T = any>(method: string, params: unknown) => Promise<T>
const scopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
]
export class GoogleConnection {
  constructor(private host: Host) {}
  async connect(clientId: string, clientSecret: string) {
    invariant(
      clientId.endsWith('.apps.googleusercontent.com'),
      'Enter a Google OAuth desktop client ID.',
    )
    const state = randomBytes(24).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    let redirect = ''
    const code = new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', redirect)
        if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
          response.writeHead(400)
          response.end('Invalid sign-in state.')
          return
        }
        const code = url.searchParams.get('code')
        response.writeHead(code ? 200 : 400, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(code ? 'Connected. You can return to Jarvis.' : 'Sign-in was not completed.')
        clearTimeout(timer)
        server.close()
        code ? resolve(code) : reject(new Error('Google sign-in was declined.'))
      })
      const timer = setTimeout(() => {
        server.close()
        reject(new Error('Google sign-in expired.'))
      }, 180_000)
      server.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        invariant(address && typeof address !== 'string', 'OAuth listener failed.')
        redirect = `http://127.0.0.1:${address.port}/callback`
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirect,
          response_type: 'code',
          scope: scopes.join(' '),
          access_type: 'offline',
          prompt: 'consent',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })
        void this.host('open.external', {
          url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
        }).catch((error) => {
          clearTimeout(timer)
          server.close()
          reject(error)
        })
      })
    })
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: await code,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    invariant(response.ok, 'Google did not accept the sign-in exchange.')
    const token = (await response.json()) as any
    await this.host('credential.set', {
      account: 'google-oauth',
      value: JSON.stringify({
        ...token,
        clientId,
        clientSecret,
        expiresAt: Date.now() + token.expires_in * 1000,
      }),
    })
    return true
  }
  private async token() {
    const stored = await this.host<string | null>('credential.get', { account: 'google-oauth' })
    invariant(stored, 'Connect Google first.')
    const token = JSON.parse(stored)
    if (Date.now() > token.expiresAt - 60_000) {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: token.clientId,
          client_secret: token.clientSecret,
          refresh_token: token.refresh_token,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(20_000),
      })
      invariant(response.ok, 'Google access was revoked. Reconnect your account.')
      const next = (await response.json()) as any
      Object.assign(token, next, { expiresAt: Date.now() + next.expires_in * 1000 })
      await this.host('credential.set', { account: 'google-oauth', value: JSON.stringify(token) })
    }
    return token
  }
  async inspect() {
    const token = await this.token()
    const get = async (url: string) => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(20_000),
      })
      invariant(
        response.ok,
        `Google access could not be verified (${response.status}). Reconnect if access was revoked.`,
      )
      return response.json() as Promise<any>
    }
    const [profile, messages, events, files] = await Promise.all([
      get('https://gmail.googleapis.com/gmail/v1/users/me/profile'),
      get('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10'),
      get(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events?' +
          new URLSearchParams({
            timeMin: new Date().toISOString(),
            maxResults: '10',
            singleEvents: 'true',
            orderBy: 'startTime',
          }),
      ),
      get(
        'https://www.googleapis.com/drive/v3/files?' +
          new URLSearchParams({
            pageSize: '10',
            fields: 'files(id,name,mimeType,modifiedTime)',
            q: 'trashed = false',
            orderBy: 'modifiedTime desc',
          }),
      ),
    ])
    const mail = await Promise.all(
      (messages.messages ?? []).slice(0, 10).map(async (item: { id: string }) => {
        const message = await get(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
        )
        const headers = message.payload?.headers ?? []
        return {
          id: message.id,
          subject: headers.find((h: any) => h.name.toLowerCase() === 'subject')?.value ?? '',
          from: headers.find((h: any) => h.name.toLowerCase() === 'from')?.value ?? '',
          snippet: message.snippet,
        }
      }),
    )
    return {
      connected: true,
      account: profile.emailAddress,
      scopes: token.scope?.split(' ') ?? scopes,
      mail,
      events: (events.items ?? []).map((item: any) => ({
        id: item.id,
        summary: item.summary,
        start: item.start,
        end: item.end,
      })),
      files: files.files ?? [],
      access: 'Read only; no mail sends or calendar writes are enabled.',
    }
  }
}
