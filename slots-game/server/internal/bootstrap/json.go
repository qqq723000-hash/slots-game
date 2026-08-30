package bootstrap

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

const (
	maximumJSONBytes int64 = 1 << 20
	maximumPEMBytes  int64 = 64 << 10
	maximumJSONDepth       = 128
)

func decodeStrictJSONFile(path string, target any) error {
	data, err := readLimitedFile(path, maximumJSONBytes)
	if err != nil {
		return err
	}
	if err := validateJSONStructure(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode JSON: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("decode JSON: trailing value")
		}
		return fmt.Errorf("decode JSON trailing data: %w", err)
	}
	return nil
}

func readLimitedFile(path string, limit int64) ([]byte, error) {
	if path == "" {
		return nil, errors.New("asset path is required")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open asset: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat asset: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("asset must be a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read asset: %w", err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("asset exceeds %d-byte limit", limit)
	}
	return data, nil
}

// validateJSONStructure 在类型化解码前运行，因为 encoding/json 的
// DisallowUnknownFields 不会拒绝重复对象成员名。签名或配置材料中的重复成员名存在风险，
// 因为不同解析器可能无法就哪个值具有权威性达成一致。
// English: validateJSONStructure is run before typed decoding because encoding/json's DisallowUnknownFields does
// not reject duplicate object member names. Duplicate member names in signature or configuration material are
// risky because different parsers may not agree on which value is authoritative.
func validateJSONStructure(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := consumeJSONValue(decoder, 0); err != nil {
		return fmt.Errorf("invalid JSON structure: %w", err)
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("invalid JSON structure: trailing value")
		}
		return fmt.Errorf("invalid JSON structure: trailing data: %w", err)
	}
	return nil
}

func consumeJSONValue(decoder *json.Decoder, depth int) error {
	if depth > maximumJSONDepth {
		return errors.New("maximum nesting depth exceeded")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, compound := token.(json.Delim)
	if !compound {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			nameToken, err := decoder.Token()
			if err != nil {
				return err
			}
			name, ok := nameToken.(string)
			if !ok {
				return errors.New("object member name is not a string")
			}
			if _, duplicate := seen[name]; duplicate {
				return fmt.Errorf("duplicate object member %q", name)
			}
			seen[name] = struct{}{}
			if err := consumeJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil {
			return err
		}
		if closing != json.Delim('}') {
			return errors.New("object is not closed")
		}
		return nil
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil {
			return err
		}
		if closing != json.Delim(']') {
			return errors.New("array is not closed")
		}
		return nil
	default:
		return fmt.Errorf("unexpected delimiter %q", delimiter)
	}
}
