CREATE TABLE IF NOT EXISTS local_operator_accounts (
    operator_id       varchar(128) NOT NULL,
    wallet_account_id varchar(128) NOT NULL,
    currency          char(3)      NOT NULL,
    balance_minor     bigint       NOT NULL CHECK (balance_minor >= 0),
    created_at        timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (operator_id, wallet_account_id, currency),
    CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (wallet_account_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE TABLE IF NOT EXISTS local_operator_wallet_operations (
    operator_id        varchar(128) NOT NULL,
    operation_id       varchar(128) NOT NULL,
    request_digest     char(64)     NOT NULL,
    fingerprint        varchar(75)  NOT NULL,
    player_id          varchar(128) NOT NULL,
    wallet_account_id  varchar(128) NOT NULL,
    rgs_session_id     varchar(128) NOT NULL,
    round_id           varchar(128) NOT NULL,
    game_id            varchar(128) NOT NULL,
    definition_version varchar(128) NOT NULL,
    definition_hash    char(64)     NOT NULL,
    round_kind         varchar(16)  NOT NULL,
    currency           char(3)      NOT NULL,
    debit_minor        bigint       NOT NULL CHECK (debit_minor >= 0),
    credit_minor       bigint       NOT NULL CHECK (credit_minor >= 0),
    balance_minor      bigint       NOT NULL CHECK (balance_minor >= 0),
    transaction_id     varchar(128) NOT NULL,
    rolled_back        boolean      NOT NULL DEFAULT false,
    created_at         timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (operator_id, operation_id),
    UNIQUE (operator_id, transaction_id),
    FOREIGN KEY (operator_id, wallet_account_id, currency)
        REFERENCES local_operator_accounts (operator_id, wallet_account_id, currency),
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
    CHECK (fingerprint ~ '^rgs-fp-v2:[a-f0-9]{64}$'),
    CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
    CHECK (round_kind IN ('BASE', 'FREE_SPIN', 'BONUS')),
    CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (player_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (wallet_account_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (rgs_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (round_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (game_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (definition_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (currency ~ '^[A-Z]{3}$'),
    CHECK (transaction_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);

CREATE INDEX IF NOT EXISTS local_operator_operations_account_created
    ON local_operator_wallet_operations (operator_id, wallet_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS local_operator_wallet_rollbacks (
    operator_id        varchar(128) NOT NULL,
    rollback_id        varchar(128) NOT NULL,
    operation_id       varchar(128) NOT NULL,
    request_digest     char(64)     NOT NULL,
    reason             varchar(512) NOT NULL,
    transaction_id     varchar(128) NOT NULL,
    balance_minor      bigint       NOT NULL CHECK (balance_minor >= 0),
    created_at         timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (operator_id, rollback_id),
    UNIQUE (operator_id, operation_id),
    UNIQUE (operator_id, transaction_id),
    FOREIGN KEY (operator_id, operation_id)
        REFERENCES local_operator_wallet_operations (operator_id, operation_id),
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
    CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (rollback_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (length(reason) BETWEEN 1 AND 512),
    CHECK (transaction_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);

CREATE TABLE IF NOT EXISTS local_operator_nonces (
    operator_id varchar(128) NOT NULL,
    key_id      varchar(128) NOT NULL,
    nonce_hash  char(64)     NOT NULL,
    expires_at  timestamptz  NOT NULL,
    created_at  timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (operator_id, key_id, nonce_hash),
    CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
    CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);

CREATE INDEX IF NOT EXISTS local_operator_nonces_expiry
    ON local_operator_nonces (expires_at);
