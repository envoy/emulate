import io.getstream.chat.java.models.Channel;
import io.getstream.chat.java.models.Message;
import io.getstream.chat.java.models.User;
import io.getstream.chat.java.services.framework.DefaultClient;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Properties;

/**
 * Drives stream-chat-java exactly as communication-service's StreamClientService does,
 * against the emulator. The base URL comes from the STREAM_CHAT_URL environment variable,
 * which DefaultClient reads itself; the key and secret are passed as properties, as
 * StreamClientService passes them. Prints one line per step for the calling test.
 *
 * Usage: java -cp <stream-chat-java 1.32.0 classpath> StreamJavaProbe.java <key> <secret> <channelId>
 */
public class StreamJavaProbe {
  public static void main(String[] args) throws Exception {
    String key = args[0];
    String secret = args[1];
    String channelId = args[2];

    Properties props = new Properties();
    props.put(DefaultClient.API_KEY_PROP_NAME, key);
    props.put(DefaultClient.API_SECRET_PROP_NAME, secret);
    props.put(DefaultClient.API_TIMEOUT_PROP_NAME, "10000");
    DefaultClient.setInstance(new DefaultClient(props));

    // upsertUser: teams and name as additional fields
    for (String[] user : new String[][] {{"101", "Ada Admin"}, {"202", "Rene Recipient"}}) {
      User.UserRequestObject.UserRequestObjectBuilder builder = User.UserRequestObject.builder().id(user[0]);
      builder.additionalField("teams", List.of("7"));
      builder.additionalField("name", user[1]);
      User.upsert().user(builder.build()).request();
    }
    System.out.println("upsert ok");

    // getChannel before it exists: Channel.list filtered by cid
    var missing = Channel.list().filterCondition("cid", "emno:" + channelId).limit(1).request();
    System.out.println("list-before " + missing.getChannels().size());

    // createChannel: getOrCreate with team, created_by, members and custom data
    var channelBuilder =
        Channel.ChannelRequestObject.builder()
            .additionalField("team", "7")
            .createdBy(User.UserRequestObject.builder().id("101").build());
    channelBuilder.additionalField("name", "Rene Recipient");
    channelBuilder.additionalField("announcement_id", "4242");
    channelBuilder.additionalField("reference_type", "Announcement");
    channelBuilder.additionalField("recipient_user_id", "202");
    channelBuilder.member(Channel.ChannelMemberRequestObject.builder().userId("101").build());
    channelBuilder.member(Channel.ChannelMemberRequestObject.builder().userId("202").build());
    Channel.getOrCreate("emno", channelId).data(channelBuilder.build()).request();
    System.out.println("create ok");

    // sendMessage: a system message from user "system" with extra data
    var message =
        Message.MessageRequestObject.builder()
            .text("Fire drill")
            .userId("system")
            .type(Message.MessageType.SYSTEM)
            .additionalField("message_subtype", "announcement_content")
            .additionalField("announcement_id", "4242")
            .build();
    var sent = Message.send("emno", channelId).message(message).request();
    System.out.println("send " + sent.getMessage().getId() + " " + sent.getMessage().getType());

    // addMembers
    Channel.update("emno", channelId).addMember("303").request();
    System.out.println("add-members ok");

    // getChannel: the map StreamClientService builds from the list response
    var listed = Channel.list().filterCondition("cid", "emno:" + channelId).limit(1).request();
    var response = listed.getChannels().get(0);
    Map<String, Object> fields = response.getChannel().getAdditionalFields();
    System.out.println("recipient_user_id " + fields.get("recipient_user_id"));
    System.out.println(
        "members "
            + String.join(
                ",",
                response.getMembers().stream()
                    .map(member -> member.getUser().getId() + "/" + member.getRole())
                    .toList()));

    // freezeChannel
    Channel.partialUpdate("emno", channelId).setValue("frozen", true).request();
    var frozen = Channel.list().filterCondition("cid", "emno:" + channelId).limit(1).request();
    System.out.println("frozen " + frozen.getChannels().get(0).getChannel().getFrozen());

    // createToken: the token /api/v1/chat/token hands the browser
    String token =
        User.createToken("101", Date.from(Instant.now().plusSeconds(43200)), Date.from(Instant.now()));
    System.out.println("token " + token);
  }
}
