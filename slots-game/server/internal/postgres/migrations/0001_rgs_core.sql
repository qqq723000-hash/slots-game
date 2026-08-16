CREATE TABLE IF NOT EXISTS rgs_sessions (
    operator_id             text        NOT NULL,
    session_id              text        NOT NULL,
    player_id               text        NOT NULL,
    wallet_account_id       text        NOT NULL,
    wallet_session_id       text        NOT NULL,
    game_id                 text        NOT NULL,
    definition_version      text        NOT NULL,
    definition_hash         char(64)    NOT NULL,
    currency                char(3)     NOT NULL,
    currency_exponent       smallint    NOT NULL,
    jurisdiction            text        NOT NULL,
    status                  text        NOT NULL,
    balance_snapshot_minor  bigint      NOT NULL,
    sequence                bigint      NOT NULL DEFAULT 0,
    revision                bigint      NOT NULL DEFAULT 0,
    feature_state           jsonb       NOT NULL,
    pending_round_id        text,
    expires_at              timestamptz NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (operator_id, session_id),
    CONSTRAINT rgs_sessions_operator_id CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT rgs_sessions_session_id CHECK (session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT rgs_sessions_player_id CHECK (player_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT rgs_sessions_wallet_account_id CHECK (wallet_account_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT rgs_sessions_wallet_session_id CHECK (wallet_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT rgs_sessions_game_id CHECK (game_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT rgs_sessions_definition_version CHECK (definition_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT rgs_sessions_definition_hash CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
    CONSTRAINT rgs_sessions_currency CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT rgs_sessions_currency_exponent CHECK (currency_exponent BETWEEN 0 AND 6),
    CONSTRAINT rgs_sessions_jurisdiction CHECK (jurisdiction ~ '^[A-Z0-9][A-Z0-9-]{1,15}$'),
    CONSTRAINT rgs_sessions_status CHECK (status IN ('ACTIVE', 'BLOCKED', 'CLOSED', 'EXPIRED')),
    CONSTRAINT rgs_sessions_balance CHECK (balance_snapshot_minor >= 0),
    CONSTRAINT rgs_sessions_sequence CHECK (sequence BETWEEN 0 AND 9007199254740991),
    CONSTRAINT rgs_sessions_revision CHECK (revision >= 0),
    CONSTRAINT rgs_sessions_feature_object CHECK (jsonb_typeof(feature_state) = 'object'),
    CONSTRAINT rgs_sessions_pending_round CHECK (
        pending_round_id IS NULL OR pending_round_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS rgs_sessions_wallet_session
    ON rgs_sessions (operator_id, wallet_session_id);
CREATE INDEX IF NOT EXISTS rgs_sessions_expiry
    ON rgs_sessions (expires_at) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS rgs_rounds (
    operator_id             text        NOT NULL,
    session_id              text        NOT NULL,
    round_id                text        NOT NULL,
    server_transaction_id   text        NOT NULL,
    request_fingerprint     varchar(80) NOT NULL,
    status                  text        NOT NULL,
    round_kind              text        NOT NULL,
    game_id                 text        NOT NULL,
    definition_version      text        NOT NULL,
    definition_hash         char(64)    NOT NULL,
    currency                char(3)     NOT NULL,
    bet_minor               bigint      NOT NULL,
    charged_minor           bigint      NOT NULL,
    win_minor               bigint      NOT NULL,
    starting_revision       bigint      NOT NULL,
    resulting_revision      bigint      NOT NULL,
    sequence                bigint      NOT NULL,
    result_json             jsonb       NOT NULL,
    outcome_hash            char(64)    NOT NULL,
    wallet_transaction_id   text,
    wallet_balance_minor    bigint,
    wallet_lease_until      timestamptz,
    failure_code            text,
    retry_count             integer     NOT NULL DEFAULT 0,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    committed_at            timestamptz,
    PRIMARY KEY (operator_id, session_id, round_id),
    UNIQUE (operator_id, server_transaction_id),
    FOREIGN KEY (operator_id, session_id)
        REFERENCES rgs_sessions (operator_id, session_id),
    CONSTRAINT rgs_rounds_round_id CHECK (round_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT rgs_rounds_server_transaction CHECK (server_transaction_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT rgs_rounds_fingerprint CHECK (request_fingerprint ~ '^rgs-fp-v2:[a-f0-9]{64}$'),
    CONSTRAINT rgs_rounds_definition_hash CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
    CONSTRAINT rgs_rounds_outcome_hash CHECK (outcome_hash ~ '^[a-f0-9]{64}$'),
    CONSTRAINT rgs_rounds_result_object CHECK (jsonb_typeof(result_json) = 'object'),
    CONSTRAINT rgs_rounds_status CHECK (status IN (
        'PREPARED', 'WALLET_PENDING', 'COMMITTED', 'REJECTED',
        'ROLLBACK_PENDING', 'ROLLED_BACK', 'MANUAL_REVIEW'
    )),
    CONSTRAINT rgs_rounds_kind CHECK (round_kind IN ('BASE', 'FREE_SPIN', 'BONUS')),
    CONSTRAINT rgs_rounds_amounts CHECK (
        bet_minor > 0 AND charged_minor >= 0 AND win_minor >= 0
        AND (wallet_balance_minor IS NULL OR wallet_balance_minor >= 0)
    ),
    CONSTRAINT rgs_rounds_revisions CHECK (
        starting_revision >= 0 AND resulting_revision = starting_revision + 1
    ),
    CONSTRAINT rgs_rounds_sequence CHECK (sequence BETWEEN 1 AND 9007199254740991)
);

CREATE INDEX IF NOT EXISTS rgs_rounds_recovery
    ON rgs_rounds (status, updated_at)
    WHERE status IN ('PREPARED', 'WALLET_PENDING', 'ROLLBACK_PENDING', 'MANUAL_REVIEW');
CREATE INDEX IF NOT EXISTS rgs_rounds_created
    ON rgs_rounds (operator_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rgs_wallet_transactions (
    operator_id             text        NOT NULL,
    transaction_id          text        NOT NULL,
    session_id              text        NOT NULL,
    round_id                text        NOT NULL,
    kind                    text        NOT NULL,
    status                  text        NOT NULL,
    currency                char(3)     NOT NULL,
    amount_minor            bigint      NOT NULL,
    request_fingerprint     varchar(80) NOT NULL,
    operator_reference      text,
    response_json           jsonb,
    failure_code            text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (operator_id, transaction_id),
    FOREIGN KEY (operator_id, session_id, round_id)
        REFERENCES rgs_rounds (operator_id, session_id, round_id),
    CONSTRAINT rgs_wallet_transactions_transaction_id CHECK (
        transaction_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    CONSTRAINT rgs_wallet_transactions_fingerprint CHECK (
        request_fingerprint ~ '^rgs-fp-v2:[a-f0-9]{64}$'
    ),
    CONSTRAINT rgs_wallet_transactions_response_object CHECK (
        response_json IS NULL OR jsonb_typeof(response_json) = 'object'
    ),
    CONSTRAINT rgs_wallet_transactions_kind CHECK (kind IN ('PLAY', 'RESERVE', 'DEBIT', 'SETTLE', 'CREDIT', 'ROLLBACK')),
    CONSTRAINT rgs_wallet_transactions_status CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'ROLLED_BACK')),
    CONSTRAINT rgs_wallet_transactions_amount CHECK (amount_minor >= 0)
);

CREATE INDEX IF NOT EXISTS rgs_wallet_transactions_reconcile
    ON rgs_wallet_transactions (status, updated_at)
    WHERE status IN ('PENDING', 'UNKNOWN');

CREATE TABLE IF NOT EXISTS rgs_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operator_id     text        NOT NULL,
    aggregate_type  text        NOT NULL,
    aggregate_id    text        NOT NULL,
    event_type      text        NOT NULL,
    payload         jsonb       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    available_at    timestamptz NOT NULL DEFAULT now(),
    lease_owner     text,
    lease_until     timestamptz,
    published_at    timestamptz,
    attempts        integer     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS rgs_outbox_dispatch
    ON rgs_outbox (available_at, id)
    WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS rgs_operator_nonces (
    operator_id text        NOT NULL,
    key_id      text        NOT NULL,
    nonce_hash  char(64)    NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (operator_id, key_id, nonce_hash),
    CONSTRAINT rgs_operator_nonces_operator_id CHECK (
        operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    CONSTRAINT rgs_operator_nonces_key_id CHECK (
        key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    CONSTRAINT rgs_operator_nonces_hash CHECK (nonce_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS rgs_operator_nonces_expiry
    ON rgs_operator_nonces (expires_at);

CREATE TABLE IF NOT EXISTS rgs_launch_codes (
    code_hash           char(64)    PRIMARY KEY,
    operator_id         text        NOT NULL,
    claims_json         jsonb       NOT NULL,
    expires_at          timestamptz NOT NULL,
    consumed_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT rgs_launch_codes_hash CHECK (code_hash ~ '^[a-f0-9]{64}$'),
    CONSTRAINT rgs_launch_codes_operator_id CHECK (
        operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    CONSTRAINT rgs_launch_codes_claims_object CHECK (jsonb_typeof(claims_json) = 'object'),
    CONSTRAINT rgs_launch_codes_expiry_window CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS rgs_launch_codes_expiry
    ON rgs_launch_codes (expires_at) WHERE consumed_at IS NULL;
