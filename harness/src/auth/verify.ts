/**
 * JWT verification strategies.
 *
 * Three strategies for verifying agent tokens:
 * - SharedSecret: HS256 with a configured secret (dev/test)
 * - Jwks: RS256/ES256 via issuer's JWKS endpoint (production)
 * - Introspection: opaque token validation via OAuth introspection endpoint
 *
 * Strategy is selected by `auth.verify_strategy` in scenario.yml.
 */

import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { createHash } from 'crypto';

export interface VerifyResult {
	valid: boolean;
	sub?: string;
	iss?: string;
	aud?: string;
	exp?: number;
	error?: string;
}

export interface VerifyStrategy {
	verify(token: string, expectedAudience?: string): Promise<VerifyResult>;
}

export function tokenHash(token: string): string {
	return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

// ─── Shared Secret (HS256) ───

export class SharedSecretVerifier implements VerifyStrategy {
	constructor(private secret: string) {}

	async verify(token: string, expectedAudience?: string): Promise<VerifyResult> {
		try {
			const decoded = jwt.verify(token, this.secret, {
				algorithms: ['HS256'],
				audience: expectedAudience,
			}) as jwt.JwtPayload;

			return {
				valid: true,
				sub: decoded.sub,
				iss: decoded.iss,
				aud: typeof decoded.aud === 'string' ? decoded.aud : decoded.aud?.[0],
				exp: decoded.exp,
			};
		} catch (err) {
			return { valid: false, error: (err as Error).message };
		}
	}
}

// ─── JWKS (RS256/ES256 via issuer endpoint) ───

export class JwksVerifier implements VerifyStrategy {
	private client: jwksClient.JwksClient;
	private issuer: string | undefined;

	constructor(jwksUri: string, issuer?: string) {
		this.client = jwksClient({ jwksUri, cache: true, rateLimit: true });
		this.issuer = issuer;
	}

	private getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
		this.client.getSigningKey(header.kid, (err, key) => {
			if (err) return callback(err);
			const signingKey = key?.getPublicKey();
			callback(null, signingKey);
		});
	}

	async verify(token: string, expectedAudience?: string): Promise<VerifyResult> {
		return new Promise((resolve) => {
			const options: jwt.VerifyOptions = {
				algorithms: ['RS256', 'ES256'],
				audience: expectedAudience,
				issuer: this.issuer,
			};

			jwt.verify(token, this.getKey.bind(this), options, (err, decoded) => {
				if (err) {
					resolve({ valid: false, error: err.message });
					return;
				}
				const payload = decoded as jwt.JwtPayload;
				resolve({
					valid: true,
					sub: payload.sub,
					iss: payload.iss,
					aud: typeof payload.aud === 'string' ? payload.aud : payload.aud?.[0],
					exp: payload.exp,
				});
			});
		});
	}
}

// ─── Token Introspection (RFC 7662) ───

export class IntrospectionVerifier implements VerifyStrategy {
	constructor(
		private introspectionUrl: string,
		private clientCredentials?: { clientId: string; clientSecret: string },
	) {}

	async verify(token: string, expectedAudience?: string): Promise<VerifyResult> {
		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/x-www-form-urlencoded',
			};

			if (this.clientCredentials) {
				const basic = Buffer.from(
					`${this.clientCredentials.clientId}:${this.clientCredentials.clientSecret}`,
				).toString('base64');
				headers['Authorization'] = `Basic ${basic}`;
			}

			const resp = await fetch(this.introspectionUrl, {
				method: 'POST',
				headers,
				body: `token=${encodeURIComponent(token)}`,
			});

			const data = (await resp.json()) as {
				active: boolean;
				sub?: string;
				iss?: string;
				aud?: string | string[];
				exp?: number;
			};

			if (!data.active) {
				return { valid: false, error: 'Token is not active' };
			}

			// Enforce expected audience (RFC 7662 introspection response includes aud)
			if (expectedAudience) {
				const audClaim = data.aud;
				const audList = Array.isArray(audClaim) ? audClaim : audClaim ? [audClaim] : [];
				if (!audList.includes(expectedAudience)) {
					return {
						valid: false,
						error: `Token audience mismatch: expected "${expectedAudience}", got ${JSON.stringify(audClaim)}`,
					};
				}
			}

			// Check expiration (introspection may return exp)
			if (data.exp && data.exp * 1000 < Date.now()) {
				return { valid: false, error: 'Token is expired' };
			}

			return {
				valid: true,
				sub: data.sub,
				iss: data.iss,
				aud: Array.isArray(data.aud) ? data.aud[0] : data.aud,
				exp: data.exp,
			};
		} catch (err) {
			return { valid: false, error: `Introspection failed: ${(err as Error).message}` };
		}
	}
}

// ─── Factory ───

export interface VerifyConfig {
	strategy: 'shared_secret' | 'jwks' | 'introspection';
	jwtSecret?: string;
	jwksUri?: string;
	issuer?: string;
	introspectionUrl?: string;
}

export function createVerifier(config: VerifyConfig): VerifyStrategy {
	switch (config.strategy) {
		case 'shared_secret':
			if (!config.jwtSecret) throw new Error('auth.jwt_secret required for shared_secret strategy');
			return new SharedSecretVerifier(config.jwtSecret);

		case 'jwks':
			if (!config.jwksUri) throw new Error('auth.jwks_uri required for jwks strategy');
			return new JwksVerifier(config.jwksUri, config.issuer);

		case 'introspection':
			if (!config.introspectionUrl) throw new Error('auth.introspection_url required for introspection strategy');
			return new IntrospectionVerifier(config.introspectionUrl);

		default:
			throw new Error(`Unknown verify strategy: ${config.strategy}`);
	}
}
