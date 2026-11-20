from pydantic import BaseModel


class MainControlConfig(BaseModel):
    greeting: str = "Hello, I am your AI assistant."
    turn_detection_enabled: bool = True
    turn_detection_endpoint: str = ""
    turn_detection_timeout_ms: int = 800
    turn_detection_max_wait_ms: int = 1800
    turn_detection_fallback_rules: bool = True
