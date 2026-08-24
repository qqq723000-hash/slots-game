CREATE INDEX local_operator_wallet_sessions_relaunch_lookup
    ON local_operator_wallet_sessions (
        operator_id,
        player_id,
        wallet_account_id,
        game_id,
        definition_version,
        definition_hash,
        currency,
        expires_at DESC,
        created_at DESC
    );
