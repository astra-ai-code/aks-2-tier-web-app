output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "aks_cluster_name" {
  value = azurerm_kubernetes_cluster.main.name
}

output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "acr_name" {
  value = azurerm_container_registry.main.name
}

output "db_host" {
  value = azurerm_postgresql_flexible_server.main.fqdn
}

output "db_name" {
  value = azurerm_postgresql_flexible_server_database.main.name
}

output "db_username" {
  value = var.db_username
}

output "db_password" {
  value     = var.db_password
  sensitive = true
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.main.id
}

output "app_url" {
  value = try(
    "http://${data.kubernetes_service.ingress_nginx.status[0].load_balancer[0].ingress[0].ip}",
    "Ingress controller not yet deployed — run: kubectl get svc -n ingress-nginx ingress-nginx-controller"
  )
  description = "Public URL of the deployed app via the Nginx Ingress controller"
}
