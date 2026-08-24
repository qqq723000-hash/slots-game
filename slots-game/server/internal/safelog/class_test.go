package safelog

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type classifiedDatabaseError struct{ secret string }

func (err classifiedDatabaseError) Error() string { return err.secret }
func (classifiedDatabaseError) SQLState() string  { return "23505" }

type classifiedNetworkError struct {
	secret  string
	timeout bool
}

func (err classifiedNetworkError) Error() string { return err.secret }
func (err classifiedNetworkError) Timeout() bool { return err.timeout }
func (classifiedNetworkError) Temporary() bool   { return true }

func TestErrorClassUsesOnlyFixedLowCardinalityValues(t *testing.T) {
	t.Parallel()
	const secret = "postgres://user:password@private.example/tenant-round-123"
	for _, test := range []struct {
		name string
		err  error
		want string
	}{
		{name: "nil", want: ClassNone},
		{name: "canceled", err: context.Canceled, want: ClassCanceled},
		{name: "deadline", err: context.DeadlineExceeded, want: ClassDeadlineExceeded},
		{name: "database", err: classifiedDatabaseError{secret: secret}, want: ClassDatabase},
		{name: "network timeout", err: classifiedNetworkError{secret: secret, timeout: true}, want: ClassNetworkTimeout},
		{name: "network", err: classifiedNetworkError{secret: secret}, want: ClassNetwork},
		{name: "joined database", err: errors.Join(errors.New(secret), classifiedDatabaseError{secret: secret}), want: ClassDatabase},
		{name: "internal", err: errors.New(secret), want: ClassInternal},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := ErrorClass(test.err)
			if got != test.want || strings.Contains(got, "password") || strings.Contains(got, "tenant") {
				t.Fatalf("ErrorClass() = %q, want %q", got, test.want)
			}
		})
	}
}
