using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace AILoverLauncher
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string root = FindProjectRoot(exeDir);
            string script = Path.Combine(root, "customer_start.ps1");
            if (!File.Exists(script))
            {
                script = Path.Combine(root, "start_local_robot_agent.ps1");
            }

            if (!File.Exists(script))
            {
                MessageBox.Show(
                    "Cannot find customer_start.ps1 or start_local_robot_agent.ps1.\n\nPut AI-Lover.exe in the AI-Lover customer app folder.",
                    "AI-Lover",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            string joinedArgs = string.Join(" ", args);
            string command = string.Format(
                "-NoProfile -ExecutionPolicy Bypass -File \"{0}\" {1}",
                script,
                joinedArgs
            );

            var process = new Process();
            process.StartInfo.FileName = "powershell.exe";
            process.StartInfo.Arguments = command;
            process.StartInfo.WorkingDirectory = root;
            process.StartInfo.UseShellExecute = true;
            process.Start();
        }

        private static string FindProjectRoot(string start)
        {
            var dir = new DirectoryInfo(start);
            while (dir != null)
            {
                string appDir = Path.Combine(dir.FullName, "app");
                if (File.Exists(Path.Combine(appDir, "customer_start.ps1")) &&
                    Directory.Exists(Path.Combine(appDir, "frontend")))
                {
                    return appDir;
                }

                if ((File.Exists(Path.Combine(dir.FullName, "customer_start.ps1")) ||
                     File.Exists(Path.Combine(dir.FullName, "start_local_robot_agent.ps1"))) &&
                    Directory.Exists(Path.Combine(dir.FullName, "frontend")))
                {
                    return dir.FullName;
                }
                dir = dir.Parent;
            }
            return start;
        }
    }
}
