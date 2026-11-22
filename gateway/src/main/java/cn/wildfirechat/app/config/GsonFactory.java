package cn.wildfirechat.app.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.ToNumberPolicy;

/**
 * Shared Gson instance for the robot-gateway wire protocol.
 *
 * <p>Request params are parsed into {@code List<Object>}, so plain Gson would
 * turn every JSON number into a {@code Double} and lose precision for the
 * 64-bit message/feed ids used by Wildfire (they are &gt; 2^53). The LAZILY
 * strategy keeps the original number literal until the reflection proxy
 * converts it to the declared parameter type, so numeric ids sent by the
 * Java/Go SDKs still reach IM exactly while JS clients can send strings.
 */
public final class GsonFactory {

    private static final Gson INSTANCE = new GsonBuilder()
            .setObjectToNumberStrategy(ToNumberPolicy.LAZILY_PARSED_NUMBER)
            .create();

    private GsonFactory() {
    }

    public static Gson gson() {
        return INSTANCE;
    }
}
