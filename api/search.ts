import type { VercelRequest, VercelResponse } from '@vercel/node'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { decodePaymentSignatureHeader } from '@x402/core/http'
import { ExactStellarScheme } from '@x402/stellar/exact/server'
import {
  STELLAR_NETWORK,
  AMOUNT_USDC,
} from '../src/lib/constants'
import {
  getNetwork,
  buildPaymentRequirement,
  getPayTo,
  buildPaymentRequiredPayload,
} from '../src/lib/x402Config'
import { consumePaymentPayload } from '../src/lib/paymentIntegrity'
import { normalizeOrganicResults } from '../src/lib/serperNormalizer'
import type { SearchResponse, ApiErrorResponse } from '../src/types/index.js'

// ─── Config ───────────────────────────────────────────────────────────────
const NETWORK           = getNetwork() as 'stellar:testnet' | 'stellar:mainnet'
const RECEIVING_ADDRESS = getPayTo()
const SERPER_API_KEY    = process.env.SERPER_API_KEY!
const FACILITATOR_URL   = process.env.FACILITATOR_URL || 'https://www.x402.org/facilitator'

// ─── x402 facilitator for payment verification ────────────────────────────
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL })
const exactScheme = new ExactStellarScheme()

/**
 * Verify an x402 payment payload against payment requirements using the facilitator.
 * Never trusts header presence alone — forged, malformed, expired, and underpaid
 * payments are rejected before reaching Serper.
 */
async function verifyPayment(
  paymentHeader: string,
): Promise<{ ok: true; txHash: string | null } | { ok: false; status: number; error: string }> {
  // 1. Decode the payment payload from the header
  let paymentPayload
  try {
    paymentPayload = decodePaymentSignatureHeader(paymentHeader)
  } catch {
    return { ok: false, status: 402, error: 'Malformed payment payload' }
  }

  // 2. Validate basic payload structure
  if (!paymentPayload || typeof paymentPayload !== 'object') {
    return { ok: false, status: 402, error: 'Invalid payment payload' }
  }
  if (!paymentPayload.payload || typeof paymentPayload.payload !== 'object') {
    return { ok: false, status: 402, error: 'Malformed payment payload: missing payload field' }
  }

  // 3. Build payment requirements from shared config
  const paymentRequirements = buildPaymentRequirement() as any

  // 4. Verify with facilitator (checks signature, amount, expiry, network)
  try {
    const verifyResult = await facilitatorClient.verify(paymentPayload, paymentRequirements as any)

    if (!verifyResult.isValid) {
      return {
        ok: false,
        status: 402,
        error: verifyResult.invalidReason || 'Payment verification failed',
      }
    }
  } catch (err: any) {
    const message = err?.message || String(err)
    console.error('[x402 verify]', message)
    return { ok: false, status: 402, error: `Payment verification error: ${message}` }
  }

  // 5. Settle the payment through the facilitator
  try {
    const settleResult = await facilitatorClient.settle(paymentPayload, paymentRequirements as any)

    if (!settleResult.success) {
      return {
        ok: false,
        status: 402,
        error: settleResult.errorReason || 'Payment settlement failed',
      }
    }
  } catch (err: any) {
    const message = err?.message || String(err)
    console.error('[x402 settle]', message)
    return { ok: false, status: 402, error: `Payment settlement error: ${message}` }
  }

  // 6. Extract tx hash from payment payload
  const txHash =
    (paymentPayload.payload as Record<string, unknown>)?.transactionHash as string ||
    (paymentPayload.payload as Record<string, unknown>)?.txHash as string ||
    null

  return { ok: true, txHash }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {

  // ─── CORS ─────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', [
    'Content-Type',
    'Authorization',
    'X-Payment',
    'payment-signature',
    'x-payment',
    'X-PAYMENT',
  ].join(', '))
  res.setHeader('Access-Control-Expose-Headers', [
    'PAYMENT-REQUIRED',
    'X-Payment-Response',
  ].join(', '))

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') {
    const errorBody: ApiErrorResponse = { error: 'Method not allowed' }
    return res.status(405).json(errorBody)
  }

  const { q, count = '5', freshness } = req.query as Record<string, string>

  if (!q?.trim()) {
    const errorBody: ApiErrorResponse = { error: 'Missing required parameter: q' }
    return res.status(400).json(errorBody)
  }

  // ─── Payment check ────────────────────────────────────────────────────────
  const paymentHeader =
    req.headers['payment-signature'] ||
    req.headers['x-payment']         ||
    req.headers['X-PAYMENT']

  if (!paymentHeader || typeof paymentHeader !== 'string') {
    // Return x402 v2 payment requirements from shared config
    const requestUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['host']}${req.url}`
    const paymentRequired = buildPaymentRequiredPayload(requestUrl)

    res.setHeader(
      'PAYMENT-REQUIRED',
      Buffer.from(JSON.stringify(paymentRequired)).toString('base64')
    )
    const errorBody: ApiErrorResponse = { error: 'Payment required' }
    return res.status(402).json(errorBody)
  }

  // ─── Payment Replay Protection ───────────────────────────────────────────
  const consumption = consumePaymentPayload(paymentHeader)
  if (!consumption.ok) {
    const errorBody: ApiErrorResponse = { error: consumption.error }
    return res.status(402).json(errorBody)
  }

  // ─── Verify and settle payment via facilitator ───────────────────────────
  const verification = await verifyPayment(paymentHeader)
  if (!verification.ok) {
    const errorBody: ApiErrorResponse = { error: verification.error }
    return res.status(verification.status).json(errorBody)
  }

  const txHash = verification.txHash

  console.log('✅ Payment verified and settled via facilitator')

  const t0 = Date.now()

  try {
    // ─── Serper.dev ──────────────────────────────────────────────────────────
    const requestBody: Record<string, unknown> = {
      q:   q.trim(),
      num: Math.min(parseInt(count) || 5, 20),
    }

    if (freshness) {
      const dateFilters: Record<string, string> = {
        pd: 'qdr:d',  // past day
        pw: 'qdr:w',  // past week
        pm: 'qdr:m',  // past month
      }
      if (dateFilters[freshness]) requestBody.tbs = dateFilters[freshness]
    }

    const serperRes = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: {
        'X-API-KEY':    SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    if (!serperRes.ok) {
      const errText = await serperRes.text()
      console.error('[serper]', serperRes.status, errText)
      const errorBody: ApiErrorResponse = { error: `Serper.dev API error: ${serperRes.status}` }
      return res.status(502).json(errorBody)
    }

    const data: unknown = await serperRes.json()
    const latencyMs    = Date.now() - t0

    const results = normalizeOrganicResults(data)

    const responseBody: SearchResponse = {
      query:      q.trim(),
      results,
      count:      results.length,
      network:    NETWORK,
      paidAmount: AMOUNT_USDC,
      currency:   'USDC',
      txHash,
      latencyMs,
    }

    return res.json(responseBody)

  } catch (err: any) {
    console.error('[search error]', err.message)
    const errorBody: ApiErrorResponse = { error: 'Search failed.' }
    return res.status(500).json(errorBody)
  }
}
