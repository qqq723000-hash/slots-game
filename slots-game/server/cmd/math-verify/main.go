package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"

	"slots-game/server/internal/game"
	"slots-game/server/internal/mathreport"
)

const simulationRNGAlgorithmVersion = "splitmix64-rejection-v1"

type simulationRNG struct {
	state uint64
}

func (r *simulationRNG) next() uint64 {
	r.state += 0x9e3779b97f4a7c15
	z := r.state
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

func (r *simulationRNG) Intn(n int) (int, error) {
	if n <= 0 {
		return 0, fmt.Errorf("simulation rng bound must be positive")
	}
	bound := uint64(n)
	limit := uint64(math.MaxUint64) - uint64(math.MaxUint64)%bound
	for {
		value := r.next()
		if value < limit {
			return int(value % bound), nil
		}
	}
}

func main() {
	os.Exit(execute(os.Args[1:], os.Stdout, os.Stderr))
}

func execute(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("math-verify", flag.ContinueOnError)
	flags.SetOutput(stderr)
	paidSpins := flags.Int64("paid-spins", 1_000_000, "number of paid base-game cycles")
	betMinor := flags.Int64("bet-minor", 1_000, "bet in currency minor units")
	seed := flags.Uint64("seed", 0x7267732d6d617468, "deterministic engineering simulation seed")
	minimumRTP := flags.String("rtp-min", "", "required inclusive minimum accepted RTP ratio (0.96 means 96%)")
	maximumRTP := flags.String("rtp-max", "", "required inclusive maximum accepted RTP ratio (0.96 means 96%)")
	if err := flags.Parse(arguments); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(stderr, "math-verify does not accept positional arguments")
		return 2
	}
	if *minimumRTP == "" || *maximumRTP == "" {
		fmt.Fprintln(stderr, "math-verify requires both -rtp-min and -rtp-max; the acceptance policy must be explicit")
		return 2
	}

	config := game.DemoConfig()
	engine, err := game.NewEngine(config, &simulationRNG{state: *seed})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	report, err := mathreport.Run(context.Background(), config, engine, mathreport.Options{
		PaidSpins: *paidSpins, BetMinor: *betMinor,
		RNGAlgorithm:       simulationRNGAlgorithmVersion,
		RNGSeed:            strconv.FormatUint(*seed, 10),
		RulesSchemaVersion: mathreport.EngineRulesSchemaVersion,
		RTPMinimum:         *minimumRTP, RTPMaximum: *maximumRTP,
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(report); err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if !report.RTPAcceptance.Passed {
		fmt.Fprintf(
			stderr,
			"RTP acceptance failed: observed %s is outside inclusive range [%s, %s]\n",
			report.RTP, report.RTPAcceptance.Minimum, report.RTPAcceptance.Maximum,
		)
		return 1
	}
	return 0
}
