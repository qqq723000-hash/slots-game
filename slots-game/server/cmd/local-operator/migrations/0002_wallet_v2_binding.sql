CREATE TABLE local_operator_wallet_sessions (
    operator_id        varchar(128) NOT NULL,
    wallet_session_ref varchar(128) NOT NULL,
    player_id          varchar(128) NOT NULL,
    wallet_account_id  varchar(128) NOT NULL,
    rgs_session_id     varchar(128) NOT NULL,
    game_id            varchar(128) NOT NULL,
    definition_version varchar(128) NOT NULL,
    definition_hash    char(64)     NOT NULL,
    currency           char(3)      NOT NULL,
    expires_at         timestamptz  NOT NULL,
    created_at         timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (operator_id, wallet_session_ref),
    UNIQUE (operator_id, rgs_session_id),
    FOREIGN KEY (operator_id, wallet_account_id, currency)
        REFERENCES local_operator_accounts (operator_id, wallet_account_id, currency),
    CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (wallet_session_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (player_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (wallet_account_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (rgs_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (game_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (definition_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
    CHECK (currency ~ '^[A-Z]{3}$'),
    CHECK (expires_at > created_at)
);

CREATE INDEX local_operator_wallet_sessions_expiry
    ON local_operator_wallet_sessions (expires_at);

CREATE TABLE local_operator_wallet_rejections (
    operator_id        varchar(128) NOT NULL,
    operation_id       varchar(128) NOT NULL,
    request_digest     char(64)     NOT NULL,
    fingerprint        varchar(75)  NOT NULL,
    player_id          varchar(128) NOT NULL,
    wallet_account_id  varchar(128) NOT NULL,
    wallet_session_ref varchar(128),
    rgs_session_id     varchar(128) NOT NULL,
    round_id           varchar(128) NOT NULL,
    game_id            varchar(128) NOT NULL,
    definition_version varchar(128) NOT NULL,
    definition_hash    char(64)     NOT NULL,
    round_kind         varchar(16)  NOT NULL,
    currency           char(3)      NOT NULL,
    debit_minor        bigint       NOT NULL CHECK (debit_minor >= 0),
    credit_minor       bigint       NOT NULL CHECK (credit_minor >= 0),
    command_digest     varchar(82),
    rejection_code     varchar(64)  NOT NULL,
    created_at         timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (operator_id, operation_id),
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
    CHECK (fingerprint ~ '^rgs-fp-v2:[a-f0-9]{64}$'),
    CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (player_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (wallet_account_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (rgs_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (round_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (game_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (definition_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
    CHECK (round_kind IN ('BASE', 'FREE_SPIN', 'BONUS')),
    CHECK (currency ~ '^[A-Z]{3}$'),
    CHECK (rejection_code IN ('INSUFFICIENT_FUNDS', 'WALLET_SESSION_INVALID', 'ACCOUNT_NOT_FOUND')),
    CONSTRAINT local_operator_wallet_rejection_v2_binding_shape CHECK (
        (wallet_session_ref IS NULL AND command_digest IS NULL)
        OR
        (
            wallet_session_ref IS NOT NULL
            AND command_digest IS NOT NULL
            AND wallet_session_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
            AND command_digest ~ '^rgs-wallet-cmd-v1:[a-f0-9]{64}$'
        )
    )
);

CREATE INDEX local_operator_wallet_rejections_account_created
    ON local_operator_wallet_rejections (operator_id, wallet_account_id, created_at DESC);

ALTER TABLE local_operator_wallet_operations
    ADD COLUMN wallet_session_ref varchar(128),
    ADD COLUMN command_digest varchar(82),
    ADD CONSTRAINT local_operator_wallet_v2_binding_shape CHECK (
        (wallet_session_ref IS NULL AND command_digest IS NULL)
        OR
        (
            wallet_session_ref IS NOT NULL
            AND command_digest IS NOT NULL
            AND wallet_session_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
            AND command_digest ~ '^rgs-wallet-cmd-v1:[a-f0-9]{64}$'
        )
    ),
    ADD CONSTRAINT local_operator_wallet_operation_session_fk
        FOREIGN KEY (operator_id, wallet_session_ref)
        REFERENCES local_operator_wallet_sessions (operator_id, wallet_session_ref);
