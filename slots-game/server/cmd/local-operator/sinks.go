package main

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const auditSchema = "rgs-outbox-http-v1"

type auditEnvelope struct {
	SchemaVersion string          `json:"schemaVersion"`
	ID            string          `json:"id"`
	OperatorID    string          `json:"operatorId"`
	AggregateType string          `json:"aggregateType"`
	AggregateID   string          `json:"aggregateId"`
	EventType     string          `json:"eventType"`
	OccurredAt    string          `json:"occurredAt"`
	Payload       json.RawMessage `json:"payload"`
}

type auditJSONLStore struct {
	mu        sync.Mutex
	file      *os.File
	path      string
	maximum   int64
	fileLimit int64
	segment   int64
	total     int64
	accepted  map[string]string
}

type appendStore struct {
	mu          sync.Mutex
	file        *os.File
	path        string
	maximum     int64
	fileLimit   int64
	segment     int64
	total       int64
	prune       bool
	deduplicate bool
	accepted    map[string]struct{}
}

type sinkStoreStats struct {
	Bytes    int64
	Capacity int64
	Writable bool
	Segments int
}

func openJSONLStore(path string, maximumLineBytes, maximumFileBytes int64) (*auditJSONLStore, error) {
	return openJSONLStoreWithSegment(path, maximumLineBytes, maximumFileBytes,
		boundedSegmentSize(maximumLineBytes, maximumFileBytes, 64<<20))
}

func openJSONLStoreWithSegment(path string, maximumLineBytes, maximumFileBytes, segmentBytes int64) (*auditJSONLStore, error) {
	file, err := openSecureAppendFile(path)
	if err != nil {
		return nil, err
	}
	store := &auditJSONLStore{
		file: file, path: path, maximum: maximumLineBytes, fileLimit: maximumFileBytes,
		segment:  segmentBytes,
		accepted: make(map[string]string),
	}
	if err := store.rebuildIndex(); err != nil {
		file.Close()
		return nil, err
	}
	return store, nil
}

func openAppendStore(path string, maximumWriteBytes, maximumFileBytes int64) (*appendStore, error) {
	return openAppendStoreWithOptions(path, maximumWriteBytes, maximumFileBytes,
		boundedSegmentSize(maximumWriteBytes, maximumFileBytes, 32<<20), true, false)
}

func openDeduplicatingAppendStore(path string, maximumWriteBytes, maximumFileBytes int64) (*appendStore, error) {
	return openAppendStoreWithOptions(path, maximumWriteBytes, maximumFileBytes,
		boundedSegmentSize(maximumWriteBytes, maximumFileBytes, 8<<20), false, true)
}

func openAppendStoreWithOptions(
	path string,
	maximumWriteBytes, maximumFileBytes, segmentBytes int64,
	prune, deduplicate bool,
) (*appendStore, error) {
	file, err := openSecureAppendFile(path)
	if err != nil {
		return nil, err
	}
	store := &appendStore{
		file: file, path: path, maximum: maximumWriteBytes, fileLimit: maximumFileBytes,
		segment: segmentBytes, prune: prune, deduplicate: deduplicate,
		accepted: make(map[string]struct{}),
	}
	if err := store.rebuildState(); err != nil {
		file.Close()
		return nil, err
	}
	return store, nil
}

func boundedSegmentSize(maximumRecord, total, preferred int64) int64 {
	if maximumRecord <= 0 || total <= 0 {
		return 0
	}
	segment := preferred
	if quarter := total / 4; quarter < segment {
		segment = quarter
	}
	if segment < maximumRecord {
		segment = maximumRecord
	}
	if segment > total {
		segment = total
	}
	return segment
}

func openSecureAppendFile(path string) (*os.File, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, errors.New("sink path must be absolute")
	}
	directory := filepath.Dir(path)
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("sink parent must be an existing real directory")
	}
	if current, err := os.Lstat(path); err == nil {
		if !current.Mode().IsRegular() || current.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("sink file must be regular")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect sink file: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open sink file: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, fmt.Errorf("restrict sink file permissions: %w", err)
	}
	return file, nil
}

func (s *auditJSONLStore) rebuildIndex() error {
	if s.maximum <= 0 || s.fileLimit <= 0 || s.segment <= 0 || s.segment > s.fileLimit {
		return errors.New("audit maximum line size must be positive")
	}
	segments, err := JSONLSegments(s.path)
	if err != nil {
		return err
	}
	for _, segment := range segments {
		file, openErr := os.Open(segment)
		if openErr != nil {
			return fmt.Errorf("open audit segment: %w", openErr)
		}
		if err := requireCompleteJSONL(file); err != nil {
			file.Close()
			return fmt.Errorf("audit segment %s: %w", filepath.Base(segment), err)
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() {
			file.Close()
			return errors.New("audit segment is unavailable")
		}
		s.total += info.Size()
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 64<<10), int(s.maximum)+1)
		line := 0
		for scanner.Scan() {
			line++
			encoded := append([]byte(nil), scanner.Bytes()...)
			event, decodeErr := decodeAuditEnvelope(encoded)
			if decodeErr != nil {
				file.Close()
				return fmt.Errorf("audit segment %s line %d is invalid: %w", filepath.Base(segment), line, decodeErr)
			}
			digest := sha256.Sum256(encoded)
			encodedDigest := hex.EncodeToString(digest[:])
			if previous, exists := s.accepted[event.ID]; exists && previous != encodedDigest {
				file.Close()
				return fmt.Errorf("audit store event %s has conflicting bodies", event.ID)
			}
			s.accepted[event.ID] = encodedDigest
		}
		scanErr := scanner.Err()
		file.Close()
		if scanErr != nil {
			return fmt.Errorf("scan audit segment: %w", scanErr)
		}
	}
	if s.total > s.fileLimit {
		return errors.New("audit store exceeds its configured capacity")
	}
	_, err = s.file.Seek(0, io.SeekEnd)
	return err
}

func (s *appendStore) rebuildState() error {
	if s.maximum <= 0 || s.fileLimit <= 0 || s.segment <= 0 || s.segment > s.fileLimit {
		return errors.New("log store limits must be positive and ordered")
	}
	segments, err := JSONLSegments(s.path)
	if err != nil {
		return err
	}
	for _, segment := range segments {
		file, openErr := os.Open(segment)
		if openErr != nil {
			return fmt.Errorf("open JSONL segment: %w", openErr)
		}
		if err := requireCompleteJSONL(file); err != nil {
			file.Close()
			return fmt.Errorf("JSONL segment %s: %w", filepath.Base(segment), err)
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() {
			file.Close()
			return errors.New("JSONL segment is unavailable")
		}
		s.total += info.Size()
		if s.deduplicate {
			scanner := bufio.NewScanner(file)
			scanner.Buffer(make([]byte, 64<<10), int(s.maximum)+1)
			for scanner.Scan() {
				digest := sha256.Sum256(scanner.Bytes())
				s.accepted[hex.EncodeToString(digest[:])] = struct{}{}
			}
			if scanErr := scanner.Err(); scanErr != nil {
				file.Close()
				return fmt.Errorf("scan JSONL segment: %w", scanErr)
			}
		}
		file.Close()
	}
	if s.total > s.fileLimit && !s.prune {
		return errors.New("log store exceeds its configured capacity")
	}
	if s.total > s.fileLimit {
		if err := s.pruneArchivedSegments(0, time.Now().UTC()); err != nil {
			return err
		}
	}
	if s.total > s.fileLimit {
		return errors.New("log store exceeds its configured capacity")
	}
	_, err = s.file.Seek(0, io.SeekEnd)
	return err
}

// JSONLSegments 返回不可变归档和当前活动文件；路径、类型与符号链接均失败闭合。
// English: JSONLSegments returns an immutable archive and the currently active file; paths, types, and symbolic
// links all fail to be closed.
func JSONLSegments(path string) ([]string, error) {
	pattern := strings.TrimSuffix(path, ".jsonl") + ".*.jsonl"
	archives, err := filepath.Glob(pattern)
	if err != nil {
		return nil, fmt.Errorf("list JSONL segments: %w", err)
	}
	sort.Strings(archives)
	segments := append(archives, path)
	for _, segment := range segments {
		info, statErr := os.Lstat(segment)
		if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("JSONL segment must be a regular file")
		}
	}
	return segments, nil
}

func requireCompleteJSONL(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("inspect JSONL store: %w", err)
	}
	if info.Size() == 0 {
		return nil
	}
	var last [1]byte
	if _, err := file.ReadAt(last[:], info.Size()-1); err != nil {
		return fmt.Errorf("read JSONL store tail: %w", err)
	}
	if last[0] != '\n' {
		return errors.New("JSONL store ends with an incomplete record")
	}
	return nil
}

func (s *auditJSONLStore) Append(eventID string, encoded []byte) (bool, error) {
	if int64(len(encoded)) > s.maximum || bytes.ContainsAny(encoded, "\r\n") {
		return false, errors.New("audit event exceeds JSONL constraints")
	}
	digest := sha256.Sum256(encoded)
	encodedDigest := hex.EncodeToString(digest[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	if previous, exists := s.accepted[eventID]; exists {
		if subtle.ConstantTimeCompare([]byte(previous), []byte(encodedDigest)) != 1 {
			return false, errIdempotencyConflict
		}
		return false, nil
	}
	line := make([]byte, 0, len(encoded)+1)
	line = append(line, encoded...)
	line = append(line, '\n')
	start, seekErr := s.file.Seek(0, io.SeekEnd)
	if seekErr != nil {
		return false, fmt.Errorf("seek audit append position: %w", seekErr)
	}
	// 活动段达到阈值时先原子改名为只读归档，再创建全新的 0600 文件。
	// 归档仍计入总配额并参与启动时幂等索引重建，绝不为“腾空间”删除审计证据。
	// When the active segment reaches its threshold, atomically rename it to a read-only archive before creating a new 0600 file.
	// Archives still count toward the total quota and participate in startup idempotency-index rebuilding; audit evidence is never deleted merely to free space.
	if start > 0 && start+int64(len(line)) > s.segment {
		if err := rotateJSONLSegment(&s.file, s.path); err != nil {
			return false, fmt.Errorf("rotate audit segment: %w", err)
		}
		start = 0
	}
	// 总配额与 readiness 解耦：达到上限时仅拒绝 sink 写入，让 RGS outbox
	// 保留待投递事件；服务本身继续响应指标和告警，避免无意义重启循环。
	// English: The total quota is decoupled from readiness: only sink writes are rejected when the upper limit is
	// reached, allowing the RGS outbox to retain events to be delivered; the service itself continues to respond to
	// indicators and alarms to avoid meaningless restart cycles.
	if int64(len(line)) > s.fileLimit-s.total {
		return false, errors.New("audit store capacity is exhausted")
	}
	if err := writeFileFull(s.file, line); err != nil {
		_ = s.file.Truncate(start)
		return false, fmt.Errorf("append audit event: %w", err)
	}
	if err := s.file.Sync(); err != nil {
		_ = s.file.Truncate(start)
		_, _ = s.file.Seek(0, io.SeekEnd)
		return false, fmt.Errorf("sync audit event: %w", err)
	}
	s.total += int64(len(line))
	s.accepted[eventID] = encodedDigest
	return true, nil
}

func (s *auditJSONLStore) Ready() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := s.file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("audit store is unavailable")
	}
	return nil
}

func (s *auditJSONLStore) Stats() sinkStoreStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	segments, _ := JSONLSegments(s.path)
	return sinkStoreStats{
		Bytes: s.total, Capacity: s.fileLimit,
		Writable: s.fileLimit-s.total >= s.maximum,
		Segments: len(segments),
	}
}

func (s *auditJSONLStore) Close() error { return s.file.Close() }

func (s *appendStore) Append(encoded []byte) error {
	if int64(len(encoded)) > s.maximum || len(encoded) == 0 {
		return errors.New("log batch exceeds append constraints")
	}
	if encoded[len(encoded)-1] != '\n' {
		encoded = append(append([]byte(nil), encoded...), '\n')
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.appendLocked(encoded, "")
	return err
}

func (s *appendStore) AppendUnique(encoded []byte) (bool, error) {
	if int64(len(encoded)) > s.maximum || len(encoded) == 0 || bytes.ContainsAny(encoded, "\r\n") {
		return false, errors.New("JSON record exceeds append constraints")
	}
	digest := sha256.Sum256(encoded)
	key := hex.EncodeToString(digest[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.appendLocked(append(append([]byte(nil), encoded...), '\n'), key)
}

func (s *appendStore) appendLocked(encoded []byte, uniqueKey string) (bool, error) {
	if uniqueKey != "" {
		if _, exists := s.accepted[uniqueKey]; exists {
			return false, nil
		}
	}
	position, err := s.file.Seek(0, io.SeekEnd)
	if err != nil {
		return false, fmt.Errorf("seek log append position: %w", err)
	}
	if position > 0 && position+int64(len(encoded)) > s.segment {
		if err := rotateJSONLSegment(&s.file, s.path); err != nil {
			return false, fmt.Errorf("rotate JSONL segment: %w", err)
		}
		position = 0
	}
	if int64(len(encoded)) > s.fileLimit-s.total && s.prune {
		// 运行日志允许删除至少 24 小时前的最旧只读段；新的活动段和当天日志
		// 始终保留，避免与六小时备份归档竞争。
		// Runtime logs may delete the oldest read-only segment only after it is at least 24 hours old; the new active segment and current-day logs
		// are always retained so pruning does not compete with the six-hour backup archive.
		if err := s.pruneArchivedSegments(int64(len(encoded)), time.Now().UTC().Add(-24*time.Hour)); err != nil {
			return false, err
		}
	}
	if int64(len(encoded)) > s.fileLimit-s.total {
		return false, errors.New("log store capacity is exhausted")
	}
	if err := writeFileFull(s.file, encoded); err != nil {
		_ = s.file.Truncate(position)
		return false, fmt.Errorf("append log batch: %w", err)
	}
	if err := s.file.Sync(); err != nil {
		_ = s.file.Truncate(position)
		_, _ = s.file.Seek(0, io.SeekEnd)
		return false, fmt.Errorf("sync log batch: %w", err)
	}
	s.total += int64(len(encoded))
	if uniqueKey != "" {
		s.accepted[uniqueKey] = struct{}{}
	}
	return true, nil
}

func (s *appendStore) Ready() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := s.file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("log store is unavailable")
	}
	return nil
}

func (s *appendStore) Stats() sinkStoreStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	segments, _ := JSONLSegments(s.path)
	return sinkStoreStats{
		Bytes: s.total, Capacity: s.fileLimit,
		Writable: s.fileLimit-s.total >= s.maximum,
		Segments: len(segments),
	}
}

func (s *appendStore) pruneArchivedSegments(required int64, cutoff time.Time) error {
	pattern := strings.TrimSuffix(s.path, ".jsonl") + ".*.jsonl"
	archives, err := filepath.Glob(pattern)
	if err != nil {
		return fmt.Errorf("list archived JSONL segments: %w", err)
	}
	sort.Strings(archives)
	for _, archive := range archives {
		if s.total+required <= s.fileLimit {
			break
		}
		info, statErr := os.Lstat(archive)
		if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("archived JSONL segment is unsafe")
		}
		if info.ModTime().After(cutoff) {
			continue
		}
		if err := os.Remove(archive); err != nil {
			return fmt.Errorf("prune archived JSONL segment: %w", err)
		}
		s.total -= info.Size()
	}
	return nil
}

func rotateJSONLSegment(file **os.File, path string) error {
	if file == nil || *file == nil {
		return errors.New("JSONL store is closed")
	}
	if err := (*file).Sync(); err != nil {
		return fmt.Errorf("sync active JSONL segment: %w", err)
	}
	archive := strings.TrimSuffix(path, ".jsonl") + "." +
		time.Now().UTC().Format("20060102T150405.000000000Z") + ".jsonl"
	if _, err := os.Lstat(archive); !errors.Is(err, os.ErrNotExist) {
		return errors.New("JSONL archive path already exists")
	}
	if err := os.Rename(path, archive); err != nil {
		return fmt.Errorf("publish JSONL archive: %w", err)
	}
	if err := os.Chmod(archive, 0o400); err != nil {
		_ = os.Rename(archive, path)
		return fmt.Errorf("seal JSONL archive: %w", err)
	}
	next, err := openSecureAppendFile(path)
	if err != nil {
		_ = os.Chmod(archive, 0o600)
		_ = os.Rename(archive, path)
		return fmt.Errorf("open next JSONL segment: %w", err)
	}
	previous := *file
	*file = next
	if err := previous.Close(); err != nil {
		return fmt.Errorf("close archived JSONL segment: %w", err)
	}
	if directory, err := os.Open(filepath.Dir(path)); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func (s *appendStore) Close() error { return s.file.Close() }

// writeFileFull 只接受已安全打开的普通文件；将参数收窄到 *os.File
// 防止今后误把客户端提交内容写回 HTTP ResponseWriter。
// English: writeFileFull only accepts ordinary files that have been opened safely; narrowing the parameters to
// *os.File prevents the client from accidentally writing content submitted back to the HTTP ResponseWriter in the
// future.
func writeFileFull(writer *os.File, encoded []byte) error {
	for len(encoded) > 0 {
		written, err := writer.Write(encoded)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrShortWrite
		}
		encoded = encoded[written:]
	}
	return nil
}

type auditSinkConfig struct {
	Path              string
	KeyID             string
	HMACKey           []byte
	BearerToken       []byte
	MaximumClockSkew  time.Duration
	MaximumBodyBytes  int64
	MaximumConcurrent int
	Store             *auditJSONLStore
	Now               func() time.Time
	Metrics           *serviceMetrics
}

type auditSink struct {
	config auditSinkConfig
	slots  chan struct{}
}

func newAuditSink(config auditSinkConfig) (http.Handler, error) {
	if config.Path == "" || config.KeyID == "" || len(config.HMACKey) != sha256.Size ||
		config.MaximumClockSkew < time.Second || config.MaximumClockSkew > time.Hour ||
		config.MaximumBodyBytes < 1 || config.MaximumBodyBytes > 4<<20 ||
		config.MaximumConcurrent < 1 || config.MaximumConcurrent > 128 || config.Store == nil || config.Metrics == nil {
		return nil, errors.New("invalid audit sink configuration")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	config.HMACKey = append([]byte(nil), config.HMACKey...)
	config.BearerToken = append([]byte(nil), config.BearerToken...)
	return &auditSink{config: config, slots: make(chan struct{}, config.MaximumConcurrent)}, nil
}

func (h *auditSink) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		writer.Header().Set("Retry-After", "1")
		h.writeStatus(writer, http.StatusServiceUnavailable)
		return
	}
	if request.Method != http.MethodPost || request.URL.Path != h.config.Path ||
		request.URL.RawQuery != "" || request.Header.Get("Content-Type") != "application/json" ||
		!bearerMatches(request.Header, h.config.BearerToken) {
		h.writeStatus(writer, http.StatusUnauthorized)
		return
	}
	body, err := readBoundedBody(request.Body, h.config.MaximumBodyBytes)
	if err != nil {
		h.writeStatus(writer, http.StatusBadRequest)
		return
	}
	event, err := decodeAuditEnvelope(body)
	if err != nil || !h.verify(request, body, event) {
		h.writeStatus(writer, http.StatusUnauthorized)
		return
	}
	if _, err := h.config.Store.Append(event.ID, body); err != nil {
		if errors.Is(err, errIdempotencyConflict) {
			h.writeStatus(writer, http.StatusConflict)
			return
		}
		h.writeStatus(writer, http.StatusServiceUnavailable)
		return
	}
	h.config.Metrics.auditAccepted.Add(1)
	h.writeStatus(writer, http.StatusNoContent)
}

func (h *auditSink) verify(request *http.Request, body []byte, event auditEnvelope) bool {
	eventID := request.Header.Get("X-RGS-Event-Id")
	keyID := request.Header.Get("X-RGS-Key-Id")
	timestampText := request.Header.Get("X-RGS-Signature-Timestamp")
	digestHeader := request.Header.Get("Content-Digest")
	if eventID != event.ID || request.Header.Get("Idempotency-Key") != "outbox-"+eventID ||
		keyID != h.config.KeyID || eventID == "" || timestampText == "" || digestHeader == "" ||
		len(request.Header.Values("X-RGS-Event-Id")) != 1 ||
		len(request.Header.Values("X-RGS-Key-Id")) != 1 ||
		len(request.Header.Values("X-RGS-Signature-Timestamp")) != 1 ||
		len(request.Header.Values("Content-Digest")) != 1 ||
		len(request.Header.Values("X-RGS-Signature")) != 1 {
		return false
	}
	timestamp, err := strconv.ParseInt(timestampText, 10, 64)
	if err != nil || strconv.FormatInt(timestamp, 10) != timestampText {
		return false
	}
	delta := h.config.Now().UTC().Sub(time.Unix(timestamp, 0))
	if delta < -h.config.MaximumClockSkew || delta > h.config.MaximumClockSkew {
		return false
	}
	digest, ok := decodeWrappedBase64(digestHeader, "sha-256=:", sha256.Size)
	if !ok {
		return false
	}
	wantDigest := sha256.Sum256(body)
	if subtle.ConstantTimeCompare(digest, wantDigest[:]) != 1 {
		return false
	}
	path := request.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	authority := request.Host
	if authority == "" {
		authority = request.URL.Host
	}
	canonical := strings.Join([]string{
		auditSchema,
		`"@method": ` + request.Method,
		`"@authority": ` + strings.ToLower(authority),
		`"@path": ` + path,
		`"content-digest": ` + digestHeader,
		`"x-rgs-event-id": ` + eventID,
		`"x-rgs-key-id": ` + keyID,
		`"x-rgs-signature-timestamp": ` + timestampText,
	}, "\n")
	signature, ok := decodeWrappedBase64(request.Header.Get("X-RGS-Signature"), "hmac-sha256=:", sha256.Size)
	if !ok {
		return false
	}
	mac := hmac.New(sha256.New, h.config.HMACKey)
	_, _ = mac.Write([]byte(canonical))
	return hmac.Equal(signature, mac.Sum(nil))
}

func (h *auditSink) writeStatus(writer http.ResponseWriter, status int) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
}

func decodeWrappedBase64(value, prefix string, size int) ([]byte, bool) {
	if !strings.HasPrefix(value, prefix) || !strings.HasSuffix(value, ":") {
		return nil, false
	}
	encoded := strings.TrimSuffix(strings.TrimPrefix(value, prefix), ":")
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	return decoded, err == nil && len(decoded) == size && base64.StdEncoding.EncodeToString(decoded) == encoded
}

func decodeAuditEnvelope(encoded []byte) (auditEnvelope, error) {
	var event auditEnvelope
	if err := decodeStrictJSON(encoded, &event); err != nil {
		return auditEnvelope{}, err
	}
	identifierValues := []string{event.OperatorID, event.AggregateType, event.AggregateID, event.EventType}
	id, err := strconv.ParseInt(event.ID, 10, 64)
	occurredAt, timeErr := time.Parse(time.RFC3339Nano, event.OccurredAt)
	var payload map[string]json.RawMessage
	payloadErr := json.Unmarshal(event.Payload, &payload)
	if event.SchemaVersion != auditSchema || id <= 0 || err != nil || strconv.FormatInt(id, 10) != event.ID ||
		!allIdentifiers(identifierValues...) || timeErr != nil || occurredAt.IsZero() ||
		payloadErr != nil || payload == nil {
		return auditEnvelope{}, errors.New("invalid audit envelope")
	}
	return event, nil
}

type logSinkConfig struct {
	Path              string
	BearerToken       []byte
	MaximumBodyBytes  int64
	MaximumConcurrent int
	Store             *appendStore
	Metrics           *serviceMetrics
}

type logSink struct {
	config logSinkConfig
	slots  chan struct{}
}

func newLogSink(config logSinkConfig) (http.Handler, error) {
	if config.Path == "" || len(config.BearerToken) < 16 || config.MaximumBodyBytes < 1 ||
		config.MaximumBodyBytes > 8<<20 || config.MaximumConcurrent < 1 ||
		config.MaximumConcurrent > 128 || config.Store == nil || config.Metrics == nil {
		return nil, errors.New("invalid log sink configuration")
	}
	config.BearerToken = append([]byte(nil), config.BearerToken...)
	return &logSink{config: config, slots: make(chan struct{}, config.MaximumConcurrent)}, nil
}

func (h *logSink) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		writer.Header().Set("Retry-After", "1")
		writer.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	contentType := request.Header.Get("Content-Type")
	if request.Method != http.MethodPost || request.URL.Path != h.config.Path ||
		request.URL.RawQuery != "" || !bearerMatches(request.Header, h.config.BearerToken) ||
		(contentType != "application/x-ndjson" && contentType != "application/ndjson" && contentType != "application/json") {
		writer.WriteHeader(http.StatusUnauthorized)
		return
	}
	body, err := readBoundedBody(request.Body, h.config.MaximumBodyBytes)
	if err != nil || !validNDJSON(body, 256<<10) {
		writer.WriteHeader(http.StatusBadRequest)
		return
	}
	if err := h.config.Store.Append(body); err != nil {
		writer.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	h.config.Metrics.logBatches.Add(1)
	writer.WriteHeader(http.StatusNoContent)
}

func validNDJSON(encoded []byte, maximumLine int) bool {
	scanner := bufio.NewScanner(bytes.NewReader(encoded))
	scanner.Buffer(make([]byte, 16<<10), maximumLine+1)
	lines := 0
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 || !json.Valid(line) {
			return false
		}
		var object map[string]json.RawMessage
		if json.Unmarshal(line, &object) != nil || object == nil {
			return false
		}
		lines++
	}
	return scanner.Err() == nil && lines > 0
}

type alertWebhookAlert struct {
	Status       string            `json:"status"`
	Labels       map[string]string `json:"labels"`
	Annotations  map[string]string `json:"annotations"`
	StartsAt     string            `json:"startsAt"`
	EndsAt       string            `json:"endsAt"`
	GeneratorURL string            `json:"generatorURL"`
	Fingerprint  string            `json:"fingerprint"`
}

type alertWebhookEnvelope struct {
	Version            string              `json:"version"`
	GroupKey           string              `json:"groupKey"`
	TruncatedAlerts    int                 `json:"truncatedAlerts"`
	Status             string              `json:"status"`
	Receiver           string              `json:"receiver"`
	GroupLabels        map[string]string   `json:"groupLabels"`
	CommonLabels       map[string]string   `json:"commonLabels"`
	CommonAnnotations  map[string]string   `json:"commonAnnotations"`
	ExternalURL        string              `json:"externalURL"`
	NotificationReason string              `json:"notification_reason"`
	Alerts             []alertWebhookAlert `json:"alerts"`
}

type alertSinkConfig struct {
	Path              string
	BearerToken       []byte
	MaximumBodyBytes  int64
	MaximumConcurrent int
	Store             *appendStore
	Metrics           *serviceMetrics
}

type alertSink struct {
	config alertSinkConfig
	slots  chan struct{}
}

func newAlertSink(config alertSinkConfig) (http.Handler, error) {
	if config.Path == "" || len(config.BearerToken) < 16 || config.MaximumBodyBytes < 1 ||
		config.MaximumBodyBytes > 4<<20 || config.MaximumConcurrent < 1 ||
		config.MaximumConcurrent > 32 || config.Store == nil || config.Metrics == nil {
		return nil, errors.New("invalid alert sink configuration")
	}
	config.BearerToken = append([]byte(nil), config.BearerToken...)
	return &alertSink{config: config, slots: make(chan struct{}, config.MaximumConcurrent)}, nil
}

func (h *alertSink) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		writer.Header().Set("Retry-After", "1")
		h.writeStatus(writer, http.StatusServiceUnavailable)
		return
	}
	if request.Method != http.MethodPost || request.URL.Path != h.config.Path ||
		request.URL.RawQuery != "" || request.Header.Get("Content-Type") != "application/json" ||
		!bearerMatches(request.Header, h.config.BearerToken) {
		h.config.Metrics.alertRejected.Add(1)
		h.writeStatus(writer, http.StatusUnauthorized)
		return
	}
	body, err := readBoundedBody(request.Body, h.config.MaximumBodyBytes)
	if err != nil {
		h.config.Metrics.alertRejected.Add(1)
		h.writeStatus(writer, http.StatusBadRequest)
		return
	}
	canonical, err := decodeAlertWebhook(body)
	if err != nil {
		h.config.Metrics.alertRejected.Add(1)
		h.writeStatus(writer, http.StatusBadRequest)
		return
	}
	if _, err := h.config.Store.AppendUnique(canonical); err != nil {
		h.config.Metrics.alertRejected.Add(1)
		h.writeStatus(writer, http.StatusServiceUnavailable)
		return
	}
	h.config.Metrics.alertAccepted.Add(1)
	h.writeStatus(writer, http.StatusNoContent)
}

func (h *alertSink) writeStatus(writer http.ResponseWriter, status int) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
}

func decodeAlertWebhook(encoded []byte) ([]byte, error) {
	var envelope alertWebhookEnvelope
	if err := decodeStrictJSON(encoded, &envelope); err != nil || envelope.Version != "4" ||
		envelope.GroupKey == "" || len(envelope.GroupKey) > 4096 || envelope.Receiver != "local-production" ||
		(envelope.Status != "firing" && envelope.Status != "resolved") ||
		envelope.TruncatedAlerts < 0 || len(envelope.Alerts) < 1 || len(envelope.Alerts) > 256 ||
		!boundedStringMap(envelope.GroupLabels, 128, 256, 4096) ||
		!boundedStringMap(envelope.CommonLabels, 128, 256, 4096) ||
		!boundedStringMap(envelope.CommonAnnotations, 128, 256, 16<<10) || len(envelope.ExternalURL) > 4096 ||
		envelope.NotificationReason == "" || len(envelope.NotificationReason) > 128 {
		return nil, errors.New("invalid Alertmanager webhook envelope")
	}
	for _, alert := range envelope.Alerts {
		startsAt, startErr := time.Parse(time.RFC3339Nano, alert.StartsAt)
		if (alert.Status != "firing" && alert.Status != "resolved") || startErr != nil || startsAt.IsZero() ||
			len(alert.EndsAt) > 64 || len(alert.GeneratorURL) > 4096 || len(alert.Fingerprint) > 128 ||
			alert.Labels["alertname"] == "" ||
			!boundedStringMap(alert.Labels, 128, 256, 4096) ||
			!boundedStringMap(alert.Annotations, 128, 256, 16<<10) {
			return nil, errors.New("invalid Alertmanager alert")
		}
		if alert.EndsAt != "" {
			if _, err := time.Parse(time.RFC3339Nano, alert.EndsAt); err != nil {
				return nil, errors.New("invalid Alertmanager alert end time")
			}
		}
	}
	canonical, err := json.Marshal(envelope)
	if err != nil || bytes.ContainsAny(canonical, "\r\n") {
		return nil, errors.New("encode Alertmanager webhook envelope")
	}
	return canonical, nil
}

func boundedStringMap(values map[string]string, maximumEntries, maximumKeyBytes, maximumValueBytes int) bool {
	if values == nil || len(values) > maximumEntries {
		return false
	}
	for key, value := range values {
		if key == "" || len(key) > maximumKeyBytes || len(value) > maximumValueBytes ||
			strings.ContainsAny(key, "\r\n\x00") || strings.ContainsAny(value, "\x00") {
			return false
		}
	}
	return true
}

func alertmanagerAuthHandler(token []byte) http.Handler {
	want := append([]byte(nil), token...)
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		if (request.Method != http.MethodGet && request.Method != http.MethodHead) ||
			request.URL.Path != "/internal/auth/alertmanager" || request.URL.RawQuery != "" ||
			!bearerMatches(request.Header, want) {
			writer.Header().Set("WWW-Authenticate", `Bearer realm="alertmanager"`)
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	})
}

func bearerMatches(header http.Header, token []byte) bool {
	values := header.Values("Authorization")
	if len(values) != 1 || len(token) < 16 {
		return false
	}
	want := append([]byte("Bearer "), token...)
	provided := []byte(values[0])
	return len(provided) == len(want) && subtle.ConstantTimeCompare(provided, want) == 1
}
