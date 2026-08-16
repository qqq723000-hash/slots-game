package main

import (
	"database/sql"
	"log/slog"

	"slots-game/server/internal/outbox"
	"slots-game/server/internal/outboxruntime"
	"slots-game/server/internal/platform"
	"slots-game/server/internal/postgres"
)

func configureOutboxRuntime(
	config platform.Config,
	database *sql.DB,
	logger *slog.Logger,
	metrics *platform.Metrics,
) (*outboxruntime.Runtime, error) {
	runtimeConfig := outboxruntime.Config{
		EndpointURL: config.OutboxEndpointURL, HMACKeyID: config.OutboxHMACKeyID,
		HMACKeyFile: config.OutboxHMACKeyFile, BearerTokenFile: config.OutboxBearerTokenFile,
		RootCAFile: config.OutboxRootCAFile, ClientCertFile: config.OutboxClientCertFile,
		ClientKeyFile:      config.OutboxClientKeyFile,
		AllowInsecureHTTP:  config.Environment == platform.Development,
		WorkerMaxStaleness: config.OutboxWorkerMaxStaleness,
		BacklogMaxAge:      config.OutboxBacklogMaxAge,
		Dispatcher: outbox.DispatcherConfig{
			Owner: config.OutboxOwner, Interval: config.OutboxInterval,
			LeaseDuration: config.OutboxLeaseDuration, PublishTimeout: config.OutboxPublishTimeout,
			BatchSize: config.OutboxBatchSize, MaxParallel: config.OutboxMaxParallel,
			InitialBackoff: config.OutboxInitialBackoff, MaximumBackoff: config.OutboxMaximumBackoff,
			Observer: metrics,
		},
	}
	if config.OutboxEndpointURL == "" {
		return outboxruntime.New(runtimeConfig, nil, nil, logger)
	}
	store, err := postgres.NewOutboxStore(database)
	if err != nil {
		return nil, err
	}
	return outboxruntime.New(runtimeConfig, store, store, logger)
}
