type SupabaseClientLike = {
  rpc: (name: string, params: Record<string, unknown>) => Promise<{
    data: unknown;
    error: { code?: string } | null;
  }>;
  from: (table: string) => any;
};

export class AccountStoreError extends Error {
  code: "email_conflict" | "storage_unavailable";

  constructor(code: "email_conflict" | "storage_unavailable") {
    super(code);
    this.name = "AccountStoreError";
    this.code = code;
  }
}

function throwStoreError(error: { code?: string } | null): never {
  if (error?.code === "23505") throw new AccountStoreError("email_conflict");
  throw new AccountStoreError("storage_unavailable");
}

function bytea(hexDigest: string): string {
  if (!/^[a-f0-9]+$/i.test(hexDigest) || hexDigest.length % 2 !== 0) {
    throw new AccountStoreError("storage_unavailable");
  }
  return `\\x${hexDigest.toLowerCase()}`;
}

function mapToken(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    tokenDigest: row.token_digest,
    emailNormalized: row.email_normalized,
    nextEmailNormalized: row.next_email_normalized,
    expiresAt: row.expires_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

export function createAccountStore(client: SupabaseClientLike) {
  return {
    async getRecoveryEmail(userId: string) {
      const { data, error } = await client
        .from("account_recovery_emails")
        .select("user_id,email_normalized,verified_at")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throwStoreError(error);
      return data
        ? {
          userId: data.user_id,
          emailNormalized: data.email_normalized,
          verifiedAt: data.verified_at,
        }
        : null;
    },

    async getLatestActiveToken({ userId, purposes, now }: {
      userId: string;
      purposes: string[];
      now: string;
    }) {
      const { data, error } = await client
        .from("account_action_tokens")
        .select("id,user_id,purpose,email_normalized,next_email_normalized,expires_at,attempt_count,max_attempts,used_at,created_at")
        .eq("user_id", userId)
        .in("purpose", purposes)
        .is("used_at", null)
        .gt("expires_at", now)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throwStoreError(error);
      return mapToken(data);
    },

    async consumeRateLimit({ action, keyDigest, windowSeconds, maxRequests }: {
      action: string;
      keyDigest: string;
      windowSeconds: number;
      maxRequests: number;
    }) {
      const { data, error } = await client.rpc("consume_auth_rate_limit", {
        p_action: action,
        p_key_digest: bytea(keyDigest),
        p_window_seconds: windowSeconds,
        p_max_requests: maxRequests,
      });
      if (error || typeof data !== "boolean") throwStoreError(error);
      return data;
    },

    async isEmailOwnedByAnother({ emailNormalized, userId }: {
      emailNormalized: string;
      userId: string;
    }) {
      const { data, error } = await client
        .from("account_recovery_emails")
        .select("user_id")
        .eq("email_normalized", emailNormalized)
        .neq("user_id", userId)
        .limit(1)
        .maybeSingle();
      if (error) throwStoreError(error);
      return data !== null;
    },

    async invalidateUnusedTokens({ userId, purposes, usedAt }: {
      userId: string;
      purposes: string[];
      usedAt: string;
    }) {
      const { error } = await client
        .from("account_action_tokens")
        .update({ used_at: usedAt })
        .eq("user_id", userId)
        .in("purpose", purposes)
        .is("used_at", null);
      if (error) throwStoreError(error);
    },

    async insertToken(input: {
      userId: string;
      purpose: string;
      tokenDigest: string;
      emailNormalized: string;
      nextEmailNormalized: string | null;
      expiresAt: string;
      maxAttempts: number;
    }) {
      const { data, error } = await client
        .from("account_action_tokens")
        .insert({
          user_id: input.userId,
          purpose: input.purpose,
          token_digest: bytea(input.tokenDigest),
          email_normalized: input.emailNormalized,
          next_email_normalized: input.nextEmailNormalized,
          expires_at: input.expiresAt,
          max_attempts: input.maxAttempts,
        })
        .select("id,user_id,purpose,email_normalized,next_email_normalized,expires_at,attempt_count,max_attempts,used_at,created_at")
        .single();
      if (error) throwStoreError(error);
      return mapToken(data);
    },

    async markTokenUsed({ tokenId, usedAt }: {
      tokenId: string;
      usedAt: string;
    }) {
      const { data, error } = await client
        .from("account_action_tokens")
        .update({ used_at: usedAt })
        .eq("id", tokenId)
        .is("used_at", null)
        .select("id")
        .maybeSingle();
      if (error) throwStoreError(error);
      return data !== null;
    },

    async consumeToken({ tokenDigest, purpose, userId, maxAttempts }: {
      tokenDigest: string;
      purpose: string;
      userId: string;
      maxAttempts: number;
    }) {
      const { data, error } = await client.rpc(
        "consume_account_action_token",
        {
          p_presented_token_digest: bytea(tokenDigest),
          p_purpose: purpose,
          p_user_id: userId,
          p_caller_max_attempts: maxAttempts,
        },
      );
      if (error) throwStoreError(error);
      return mapToken(Array.isArray(data) ? data[0] : data);
    },


    async restoreConsumedToken({ tokenId, consumedAttemptCount, consumedUsedAt }: {
      tokenId: string;
      consumedAttemptCount: number;
      consumedUsedAt: string;
    }) {
      if (
        typeof tokenId !== "string" ||
        tokenId.trim() === "" ||
        !Number.isInteger(consumedAttemptCount) ||
        consumedAttemptCount < 1 ||
        typeof consumedUsedAt !== "string" ||
        consumedUsedAt.trim() === ""
      ) throw new AccountStoreError("storage_unavailable");
      const { data, error } = await client
        .from("account_action_tokens")
        .update({
          used_at: null,
          attempt_count: consumedAttemptCount - 1,
        })
        .eq("id", tokenId)
        .eq("used_at", consumedUsedAt)
        .eq("attempt_count", consumedAttemptCount)
        .select("id")
        .maybeSingle();
      if (error) throwStoreError(error);
      return data !== null;
    },
    async upsertRecoveryEmail({ userId, emailNormalized, verifiedAt }: {
      userId: string;
      emailNormalized: string;
      verifiedAt: string;
    }) {
      const { error } = await client
        .from("account_recovery_emails")
        .upsert({
          user_id: userId,
          email_normalized: emailNormalized,
          verified_at: verifiedAt,
          updated_at: verifiedAt,
        }, { onConflict: "user_id" });
      if (error) throwStoreError(error);
    },

    async updateRecoveryEmail({ userId, emailNormalized, verifiedAt }: {
      userId: string;
      emailNormalized: string;
      verifiedAt: string;
    }) {
      const { data, error } = await client
        .from("account_recovery_emails")
        .update({
          email_normalized: emailNormalized,
          verified_at: verifiedAt,
          updated_at: verifiedAt,
        })
        .eq("user_id", userId)
        .select("user_id")
        .maybeSingle();
      if (error) throwStoreError(error);
      if (!data) throw new AccountStoreError("storage_unavailable");
    },
  };
}
