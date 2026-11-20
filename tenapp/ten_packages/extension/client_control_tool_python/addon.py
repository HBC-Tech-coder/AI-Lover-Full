from ten_runtime import Addon, TenEnv, register_addon_as_extension

from .extension import ClientControlToolExtension


@register_addon_as_extension("client_control_tool_python")
class ClientControlToolAddon(Addon):
    def on_create_instance(self, ten_env: TenEnv, name: str, context) -> None:
        ten_env.log_info("Creating ClientControlToolExtension instance")
        ten_env.on_create_instance_done(ClientControlToolExtension(name), context)
