package game

import (
	"context"
	"sync/atomic"
	"testing"
)

// benchmarkSource 只用于测量引擎分配和计算路径；它不是生产随机源，也不用于验证数学分布。
// English: benchmarkSource is only used to measure engine allocation and calculation paths; it is not a source of
// randomness, nor is it used to verify mathematical distributions.
type benchmarkSource struct {
	value atomic.Uint64
}

func (s *benchmarkSource) Intn(n int) (int, error) {
	value := s.value.Add(1)
	return int(value % uint64(n)), nil
}

func BenchmarkEngineSpinRepresentative(b *testing.B) {
	engine, err := NewEngine(DemoConfig(), &benchmarkSource{})
	if err != nil {
		b.Fatalf("创建基准引擎失败：%v", err)
	}
	input := SpinInput{
		BetMinor: 100,
		Feature: FeatureState{
			Mode:          FeatureNone,
			RageLevel:     DefaultRageLevel,
			RageCollected: 0,
		},
	}

	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		if _, err := engine.Spin(context.Background(), input); err != nil {
			b.Fatalf("基准旋转失败：%v", err)
		}
	}
}

func TestEngineSpinRepresentativeAllocationBudget(t *testing.T) {
	engine, err := NewEngine(DemoConfig(), &benchmarkSource{})
	if err != nil {
		t.Fatalf("创建分配预算引擎失败：%v", err)
	}
	input := SpinInput{
		BetMinor: 100,
		Feature: FeatureState{
			Mode:          FeatureNone,
			RageLevel:     DefaultRageLevel,
			RageCollected: 0,
		},
	}

	allocations := testing.AllocsPerRun(100, func() {
		if _, spinErr := engine.Spin(context.Background(), input); spinErr != nil {
			panic(spinErr)
		}
	})
	// 预算刻意高于当前代表性路径的约 22 次分配，允许不同合法结果带来的小幅波动，
	// 但会阻止重新引入逐路径 map、排序切片或每局重复复制完整数学定义等明显回退。
	// English: The budget is deliberately higher than the current representative path's ~22 allocations, allowing for
	// small fluctuations in different legal outcomes, but preventing significant fallbacks such as reintroducing
	// path-by-path maps, sorted slicing, or repeated duplication of full mathematical definitions per round.
	if allocations > 32 {
		t.Fatalf("代表性 Spin 平均分配 %.2f 次，超过预算 32 次", allocations)
	}
}
