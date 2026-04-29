# Production Logging Guide

هذا المستند موجّه للفريق كمرجع عملي عند بناء أو مراجعة أي logging behavior في بيئات `staging` و`production` ضمن خدمات `Laravel` و`NestJS`.

القاعدة الأساسية هنا: logging في الإنتاج ليس للفضول، بل للتشخيص السريع، التحقيق في الأعطال، التتبع بين الخدمات، وتقليل زمن الاستجابة للحوادث. لذلك يجب أن تكون كل توصية في هذا المستند قابلة للتنفيذ، قابلة للاختبار، ومرتبطة بخطر إنتاجي واضح مثل فقدان السجلات، تسريب بيانات حساسة، أو تضخم حجم التخزين.

## 1. Production Logging Guidelines

### 1.1 Use structured logs

استخدم `JSON` أو أي صيغة منظمة وثابتة. الهدف أن يكون كل log event قابلًا للقراءة من البشر وقابلًا للتحليل آليًا.

الحقول المطلوبة:

- `timestamp`
- `level`
- `message`
- `env`
- `service`
- `component`
- `request_id` أو `correlation_id` عند توفره

الحقول الموصى بها:

- `user_id`
- `entity_id`
- `job_name`
- `duration_ms`
- `error_code`
- `http_method`
- `path`
- `status_code`

قاعدة عملية:

- إذا كنت تراجع log ولا تستطيع من سطر واحد معرفة "ماذا حدث، أين حدث، وفي أي طلب؟" فالسجل غير كافٍ.

مثال عملي:

```json
{
  "timestamp": "2026-04-25T10:15:23.123Z",
  "level": "error",
  "message": "Failed to index product",
  "env": "production",
  "service": "search-app",
  "component": "ElasticsearchService",
  "request_id": "req-91df",
  "entity_id": 55421,
  "duration_ms": 182,
  "error_code": "ES_INDEX_FAILED"
}
```

### 1.2 Log levels

استخدم المستويات بشكل منضبط:

- `error`: فشل حقيقي يحتاج انتباهًا أو تدخلًا.
- `warn`: سلوك غير طبيعي لكنه تم التعامل معه.
- `info`: أحداث مهمة على مستوى النظام أو business flow.
- `debug`: تفاصيل تشخيصية للتطوير المحلي أو التحقيق المؤقت.

القاعدة:

- لا يجوز تشغيل `production` بمستوى `debug` noisy بشكل افتراضي.

أمثلة:

- `error`: فشل حفظ order أو فشل الاتصال بخدمة خارجية بعد retries.
- `warn`: timeout تم التعامل معه عبر fallback.
- `info`: job بدأت أو انتهت، طلب indexing اكتمل، consumer استلم رسالة.
- `debug`: payload مختصر أثناء التطوير المحلي فقط.

### 1.3 Do not log sensitive data

ممنوع تسجيل البيانات الحساسة التالية:

- كلمات المرور
- `access tokens`
- `refresh tokens`
- `full JWT payloads`
- `Authorization` headers
- بيانات الدفع
- البيانات الشخصية الحساسة إلا عند الضرورة القصوى وبعد masking

مثال سيئ:

```js
logger.info("Authenticated request", {
  jwt_payload,
  authorization_header
})
```

مثال جيد:

```js
logger.info("Authenticated request", {
  user_id,
  token_id: jti,
  request_id
})
```

القاعدة العملية:

- إذا كانت المعلومة تصلح للدخول، الانتحال، أو كشف بيانات شخصية، فلا تُسجلها.
- استخدم `masking` أو `redaction` قبل الكتابة إلى logs.

### 1.4 Do not log huge payloads

تجنب تسجيل:

- `full request bodies`
- `full responses`
- مصفوفات كبيرة
- بيانات `binary/base64`

فضّل تسجيل:

- `ids`
- `counts`
- `sizes`
- حقول محددة وآمنة

مثال:

بدل:

```js
logger.info("Search response", { response })
```

استخدم:

```js
logger.info("Search response summary", {
  request_id,
  result_count,
  duration_ms,
  index_name
})
```

### 1.5 Correlation ID

كل طلب HTTP يجب أن يمتلك `request_id` أو `correlation_id`.

ويجب تمريره إلى:

- `downstream HTTP calls`
- `queues/events`
- `background jobs` قدر الإمكان

الهدف:

- ربط رحلة الطلب بين `Laravel`, `NestJS`, المستهلكين، والخدمات الخارجية.

القاعدة العملية:

- إذا جاء الطلب من gateway ومعه `X-Request-ID`, استخدمه.
- إذا لم يوجد، أنشئ واحدًا جديدًا في أول نقطة دخول.
- أعده في الاستجابة headers متى كان ذلك مناسبًا.

### 1.6 Background jobs and consumers

كل `job` أو `consumer` يجب أن يسجل على الأقل:

- `started`
- `succeeded`
- `failed`
- `duration_ms`
- `retry_count` عند توفره
- `message_id` أو `event_id` عند توفره

مثال:

```json
{
  "level": "info",
  "message": "Consumer job started",
  "service": "search-consumer",
  "job_name": "sync_product_to_index",
  "message_id": "amqp-7781",
  "request_id": "req-91df"
}
```

```json
{
  "level": "error",
  "message": "Consumer job failed",
  "service": "search-consumer",
  "job_name": "sync_product_to_index",
  "message_id": "amqp-7781",
  "retry_count": 2,
  "duration_ms": 812,
  "error_code": "ES_TIMEOUT"
}
```

### 1.7 Errors and exceptions

كل `error log` يجب أن يحتوي على:

- رسالة واضحة
- نوع الاستثناء أو `exception class/type`
- `safe error message`
- `stack trace` فقط عند الحاجة وبشكل مناسب
- `request_id`
- معرفات الكيانات المهمة
- عدم وجود أي أسرار

قاعدة عملية:

- لا يكفي كتابة `Something went wrong`.
- اكتب ماذا فشل، في أي component، وعلى أي entity، وتحت أي request.

مثال جيد:

```php
Log::error('Failed to fetch product from Elasticsearch', [
    'service' => 'search-app',
    'component' => 'ElasticsearchService',
    'request_id' => $requestId,
    'entity_id' => $productId,
    'exception' => get_class($e),
    'error_message' => $e->getMessage(),
]);
```
