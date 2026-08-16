{{- define "slots.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "slots.fullnameBase" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "slots.name" .) | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "slots.fullname" -}}
{{- include "slots.fullnameBase" . | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "slots.resourceName" -}}
{{- $base := include "slots.fullnameBase" .root -}}
{{- $suffix := .suffix -}}
{{- $plain := printf "%s-%s" $base $suffix -}}
{{- if le (len $plain) 63 -}}
{{- $plain -}}
{{- else -}}
{{- $hash := sha256sum $base | trunc 16 -}}
{{- $prefixLength := sub 63 (add (len $suffix) 18) -}}
{{- printf "%s-%s-%s" ($base | trunc (int $prefixLength) | trimSuffix "-") $hash $suffix -}}
{{- end -}}
{{- end -}}

{{- define "slots.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "slots.commonLabels" -}}
helm.sh/chart: {{ include "slots.chart" . }}
app.kubernetes.io/part-of: slots-game
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/name: {{ include "slots.name" . }}
{{- end -}}

{{- define "slots.selectorLabels" -}}
app.kubernetes.io/name: {{ include "slots.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "slots.image" -}}
{{- printf "%s@%s" .repository .digest -}}
{{- end -}}

{{- define "slots.runtimeAssetPath" -}}
{{- printf "/run/rgs/assets/%s" . -}}
{{- end -}}
