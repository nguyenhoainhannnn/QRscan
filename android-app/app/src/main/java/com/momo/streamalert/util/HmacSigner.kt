package com.momo.streamalert.util

import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object HmacSigner {

    private const val HMAC_SHA256 = "HmacSHA256"

    /**
     * Tính chữ ký HMAC-SHA256 ở định dạng chuỗi Hex viết thường.
     * Khớp chính xác với logic xác thực của Node.js Express server:
     * crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
     */
    fun calculateHmac(payload: String, secret: String): String {
        val keySpec = SecretKeySpec(secret.toByteArray(StandardCharsets.UTF_8), HMAC_SHA256)
        val mac = Mac.getInstance(HMAC_SHA256)
        mac.init(keySpec)
        val rawHmac = mac.doFinal(payload.toByteArray(StandardCharsets.UTF_8))
        return rawHmac.joinToString("") { "%02x".format(it) }
    }
}
