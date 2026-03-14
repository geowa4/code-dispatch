import { $ } from "bun";

export class TmuxController {
  constructor(private session: string) {}

  async ensureSession(firstWindow: string, cwd: string): Promise<void> {
    try {
      await $`tmux has-session -t ${`=${this.session}`}`.quiet();
    } catch {
      await $`tmux new-session -d -s ${this.session} -n ${firstWindow} -c ${cwd} -x 200 -y 50`.quiet();
      return;
    }
    await this.createWindow(firstWindow, cwd);
  }

  async createWindow(name: string, cwd: string): Promise<void> {
    await $`tmux new-window -d -t ${`=${this.session}`} -n ${name} -c ${cwd}`.quiet();
  }

  async sendKeys(windowName: string, command: string): Promise<void> {
    const target = `=${this.session}:=${windowName}`;
    await $`tmux send-keys -t ${target} ${command} Enter`.quiet();
  }

  async capturePane(windowName: string): Promise<string> {
    const target = `=${this.session}:=${windowName}`;
    const result = await $`tmux capture-pane -t ${target} -p -J -S -`.text();
    return result;
  }

  async getCurrentCommand(windowName: string): Promise<string> {
    const target = `=${this.session}:=${windowName}`;
    const result =
      await $`tmux display-message -t ${target} -p '#{pane_current_command}'`.text();
    return result.trim();
  }

  async isIdle(windowName: string): Promise<boolean> {
    const cmd = await this.getCurrentCommand(windowName);
    return ["bash", "zsh", "sh", "fish", "bun", "node"].includes(cmd);
  }

  async splitPane(
    windowName: string,
    cwd: string,
    command: string,
  ): Promise<void> {
    const target = `=${this.session}:=${windowName}`;
    await $`tmux split-window -h -t ${target} -c ${cwd}`.quiet();
    const newTarget = `=${this.session}:=${windowName}.{last}`;
    await $`tmux send-keys -t ${newTarget} ${command} Enter`.quiet();
  }
}
