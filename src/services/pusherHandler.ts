import type { Env } from "../types";
import type { PusherResponse } from "../types";

let cachedHmacKey: CryptoKey | null = null;
let cachedSecret: string | null = null;
const encoder = new TextEncoder();

function createTimer(label: string) {
    const start = performance.now();
    return {
        end: (): number => {
            const duration = performance.now() - start;
            console.log(`[PUSHER_PERF] ${label}: ${duration.toFixed(2)}ms`);
            return duration;
        }
    };
}

async function getOrCreateHmacKey(secret: string): Promise<CryptoKey> {
    const timer = createTimer('HMAC Key Import');
    
    if (cachedHmacKey && cachedSecret === secret) {
        // console.log('[PUSHER_PERF] HMAC Key: Using cached key');
        timer.end();
        return cachedHmacKey;
    }
    
    cachedHmacKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    cachedSecret = secret;
    timer.end();
    return cachedHmacKey;
}

async function computeHmacSignature(key: CryptoKey, message: string): Promise<string> {
    const timer = createTimer('HMAC Signature');
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    const signature = Array.from(new Uint8Array(signatureBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    timer.end();
    return signature;
}

async function computeMD5(message: string): Promise<string> {
    const timer = createTimer('MD5 Hash');
    // Note: MD5 is not available in subtle.digest in all environments (like Node), 
    // but works in Cloudflare Workers and Browsers.
    const hashBuffer = await crypto.subtle.digest('MD5' as any, encoder.encode(message));
    const hash = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    timer.end();
    return hash;
}

export async function sendPusherEvent(
    env: Env, 
    eventType: string, 
    eventData: any, 
    channel: string
): Promise<PusherResponse> {
    const overallTimer = createTimer('Total Pusher Event');
    const { PUSHER_APP_ID: appId, PUSHER_APP_KEY: key, PUSHER_APP_SECRET: secret, PUSHER_APP_CLUSTER: cluster } = env;
    
    const bodyTimer = createTimer('Build Body');
    const urlPath = `/apps/${appId}/events`;
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
        name: eventType,
        channel: channel,
        data: JSON.stringify(eventData),
    });
    console.log(`[PUSHER_PERF] Body size: ${body.length} bytes`);
    bodyTimer.end();
    
    const cryptoTimer = createTimer('Crypto Operations (Parallel)');
    const [bodyMd5, keyObj] = await Promise.all([
        computeMD5(body),
        getOrCreateHmacKey(secret)
    ]);
    cryptoTimer.end();
    
    const sigTimer = createTimer('Build Auth Signature');
    const queryParams = new URLSearchParams({
        auth_key: key,
        auth_timestamp: timestamp.toString(),
        auth_version: '1.0',
        body_md5: bodyMd5,
    });
    const stringToSign = `POST\n${urlPath}\n${queryParams.toString()}`;
    const signature = await computeHmacSignature(keyObj, stringToSign);
    queryParams.append('auth_signature', signature);
    sigTimer.end();
    
    const endpoint = `https://api-${cluster}.pusher.com${urlPath}?${queryParams.toString()}`;
    
    const networkTimer = createTimer('Network Request to Pusher');
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });
    const networkTime = networkTimer.end();
    
    const responseTimer = createTimer('Read Response');
    const text = await response.text();
    responseTimer.end();
    
    const totalTime = overallTimer.end();
    
    return {
        ok: response.ok,
        status: response.status,
        text,
        _perf: {
            total: totalTime,
            network: networkTime,
        }
    };
}

export async function sendPusherBatchEvent(
    env: Env, 
    events: any[], 
    channel: string
): Promise<PusherResponse> {
    const overallTimer = createTimer(`Total Batch Event (${events.length} events)`);
    const { PUSHER_APP_ID: appId, PUSHER_APP_KEY: key, PUSHER_APP_SECRET: secret, PUSHER_APP_CLUSTER: cluster } = env;
    
    const urlPath = `/apps/${appId}/batch_events`; 
    const timestamp = Math.floor(Date.now() / 1000);

    const body = JSON.stringify({
        batch: events.map((event) => ({
            channel: channel,
            name: event.type || 'message.received',
            data: JSON.stringify(event),
        })),
    });

    const [bodyMd5, keyObj] = await Promise.all([
        computeMD5(body),
        getOrCreateHmacKey(secret)
    ]);
    
    const queryParams = new URLSearchParams({
        auth_key: key,
        auth_timestamp: timestamp.toString(),
        auth_version: '1.0',
        body_md5: bodyMd5,
    });

    const stringToSign = `POST\n${urlPath}\n${queryParams.toString()}`;
    const signature = await computeHmacSignature(keyObj, stringToSign);
    queryParams.append('auth_signature', signature);
    
    const endpoint = `https://api-${cluster}.pusher.com${urlPath}?${queryParams.toString()}`;
    
    const networkTimer = createTimer('Network Request to Pusher');
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });
    const networkTime = networkTimer.end();
    
    const text = await response.text();
    const totalTime = overallTimer.end(); 
    
    if (!response.ok) {
        console.error(`PUSHER ERROR [${response.status}]:`, text);
    }else {
        console.log(`PUSHER SUCCESS: Sent ${events.length} events to ${channel}`);
    }
    
    return { 
        ok: response.ok, 
        status: response.status, 
        text,
        _perf: {
            total: totalTime,
            network: networkTime,
            perEvent: totalTime / events.length,
        }
    };
}